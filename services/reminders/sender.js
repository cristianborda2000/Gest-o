'use strict';
const https = require('node:https');
const dns = require('node:dns');
const { BlockList, isIP } = require('node:net');
const { validateSubscription } = require('./validation');
const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::',128],['::1',128],['fc00::',7],['fe80::',10],['ff00::',8],['2001:db8::',32]]) blocked.addSubnet(address, prefix, 'ipv6');
function publicAddress(address) {
  const family = isIP(address);
  // IPv4-mapped IPv6 is evaluated as IPv4 by Node BlockList as well.
  return Boolean(family && !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6'));
}
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(item => !publicAddress(item.address))) return callback(new Error('UNSAFE_PUSH_ADDRESS'));
    const candidates = options?.family ? addresses.filter(item => item.family === options.family) : addresses;
    if (!candidates.length) return callback(new Error('PUSH_DNS_UNAVAILABLE'));
    if (options?.all) callback(null, candidates);
    else callback(null, candidates[0].address, candidates[0].family);
  });
}
function createSender(config, dependencies = {}) {
  const webpush = dependencies.webpush || require('web-push');
  const request = dependencies.request || https.request;
  const agent = dependencies.agent || new https.Agent({ lookup: safeLookup });
  return async (subscription, payload) => {
    const validated = validateSubscription(subscription);
    const details = webpush.generateRequestDetails(validated, JSON.stringify(payload), {
      TTL: 120, urgency: 'high', contentEncoding: 'aes128gcm',
      vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey }
    });
    // Native https never follows Location responses. DNS is checked at the actual
    // connection, avoiding an SSRF validation/connection race.
    await new Promise((resolve, reject) => {
      let timeout;
      const req = request(details.endpoint, { method: 'POST', headers: details.headers, agent }, res => {
        res.resume();
        res.on('error', reject);
        res.on('end', () => {
          clearTimeout(timeout);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve();
          else { const error = new Error('PUSH_REJECTED'); error.statusCode = res.statusCode; reject(error); }
        });
      });
      req.on('error', error => { clearTimeout(timeout); reject(error); });
      timeout = setTimeout(() => req.destroy(new Error('PUSH_TIMEOUT')), 10000);
      req.end(details.body);
    });
  };
}
module.exports = { createSender, publicAddress };
