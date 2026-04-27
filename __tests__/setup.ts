// Test setup: provide required env vars so config.ts doesn't throw
process.env.BOT_TOKEN = 'test_bot_token';
process.env.PRIVATE_KEY = '5K' + '1'.repeat(85); // dummy base58
process.env.PUBLIC_KEY = '11111111111111111111111111111111';
process.env.RPC_URL = 'http://localhost:8899';
process.env.GRPC_ENDPOINT = 'http://localhost:10000';
process.env.GRPC_TOKEN = 'test_token';
process.env.SIMULATE = 'true';
