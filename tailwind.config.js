/** @type {import('tailwindcss').Config} */
// Configuracao do Tailwind.
// O Tailwind procura classes no HTML e nos arquivos JS que montam partes da tela.
module.exports = {
  content: [
    "./outputs/zama-tailwind/index.html",
    "./outputs/zama-tailwind/assets/js/**/*.js"
  ],
  theme: {
    extend: {
      colors: {
        zama: {
          orange: "#ff6b00",
          orangeDark: "#e25700",
          ink: "#111827"
        }
      }
    }
  },
  plugins: []
};
