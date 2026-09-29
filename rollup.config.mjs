import {nodeResolve} from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';

// `npm run build`: dist/octopus-tariff-compare-card.js with ApexCharts bundled in (what HACS installs).
// `npm run build:dev`: build/octopus-tariff-compare-card.dev.js, loading ApexCharts from jsDelivr instead (small, for quick testing).
const dev = process.env.BUILD === 'dev';
const APEX_CDN = 'https://cdn.jsdelivr.net/npm/apexcharts@4.7.0/dist/apexcharts.esm.js';

export default {
  input: 'src/octopus-tariff-compare-card.js',
  external: dev ? ['apexcharts'] : [],
  output: {
    file: dev ? 'build/octopus-tariff-compare-card.dev.js' : 'dist/octopus-tariff-compare-card.js',
    format: 'es',
    paths: dev ? {apexcharts: APEX_CDN} : undefined,
  },
  plugins: [nodeResolve({browser: true}), terser({format: {comments: false}})],
};
