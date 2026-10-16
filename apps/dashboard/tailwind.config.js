/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        cream: {
          50: "#FFFDF7",
          100: "#FAF9F0", // primary background
          200: "#F5F2D8", // card surface accent
          300: "#ECE7C2",
        },
        // Muted text on the cream and white pages: the stock slate-400/500 are 2.4-4.3:1 there; these are 4.6:1 or better.
        slate: {
          400: "#616f84",
          500: "#55647a",
        },
        amber: {
          500: "#F0C05A", // primary gold accent
          600: "#D9A53D",
        },
        heading: "#1E2B27", // dark green-gray
      },
      borderRadius: {
        '2xl': '16px',
        '3xl': '24px',
        '4xl': '32px',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        serif: ['Georgia', 'serif'],
      },
    },
  },
  plugins: [],
};
