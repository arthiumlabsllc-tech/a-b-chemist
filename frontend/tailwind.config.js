/**
 * Tailwind configuration.
 *
 * Two things here are product decisions rather than taste:
 *
 *  - `minWidth/minHeight.touch` at 44px. This is a till operated standing up, on
 *    a touchscreen, often in a hurry and sometimes in gloves. A 32px button is
 *    a mis-sale, and a mis-sale is a stock figure that no longer matches the
 *    shelf.
 *  - The palette is anchored on Ghana green and gold. They are separated by a
 *    large step in lightness as well as in hue, which is the property that
 *    survives reduced colour discrimination: `primary-500` is dark and
 *    `accent-500` is light, so the two still read as different when hue does not
 *    carry the distinction. `danger` stays red and is never the only signal for
 *    a destructive action.
 *
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  content: ['./src/app/**/*.{js,ts,jsx,tsx,mdx}', './src/components/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#f0fdf4',
          100: '#dcfce7',
          200: '#bbf7d0',
          300: '#86efac',
          400: '#4ade80',
          500: '#008753',
          600: '#006b3f',
          700: '#005532',
          800: '#004028',
          900: '#002d1c',
        },
        accent: {
          50: '#fffbeb',
          100: '#fef3c7',
          200: '#fde68a',
          300: '#fcd34d',
          400: '#fbbf24',
          500: '#fcd116',
          600: '#d4a80e',
          700: '#a17f0a',
          800: '#7a6008',
          900: '#5c4806',
        },
        danger: {
          50: '#fef2f2',
          100: '#fee2e2',
          500: '#ef4444',
          600: '#dc2626',
          700: '#b91c1c',
        },
        surface: {
          50: '#fafafa',
          100: '#f5f5f5',
          200: '#e5e5e5',
          300: '#d4d4d4',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '0.875rem' }],
      },
      minWidth: {
        touch: '44px',
        'touch-lg': '48px',
      },
      minHeight: {
        touch: '44px',
        'touch-lg': '48px',
      },
      animation: {
        'slide-up': 'slideUp 0.3s ease-out',
        'fade-in': 'fadeIn 0.2s ease-in',
        'pulse-slow': 'pulse 3s infinite',
      },
      keyframes: {
        slideUp: {
          '0%': { transform: 'translateY(10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
      },
    },
  },
  plugins: [],
};
