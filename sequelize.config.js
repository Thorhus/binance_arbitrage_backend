module.exports = {
	development: {
		username: 'root',
		password: '',
		database: 'arbitrage_db',
		host: '127.0.0.1',
		port: 3306,
		dialect: 'mysql',
		dialectOptions: { decimalNumbers: true },
		logging: true,
	},
	production: {
		username: 'arbitrage',
		password: 'pTExTTGB5dzP',
		database: 'arbitrage_db',
		host: '127.0.0.1',
		port: 3306,
		dialect: 'mysql',
		dialectOptions: { decimalNumbers: true },
		logging: false,
	},
};
