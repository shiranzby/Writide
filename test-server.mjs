process.env.PORT = '5187';
process.env.PLAYWRIGHT_TEST_SERVER = '1';

await import('./server.mjs');
