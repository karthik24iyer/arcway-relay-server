const backend = process.env.POSTGRES_URL ? require('./pg') : require('./sqlite');
console.log(`[storage] backend: ${process.env.POSTGRES_URL ? 'postgres' : `sqlite (${process.env.SQLITE_PATH || '/data/relay.db'})`}`);
module.exports = backend;
