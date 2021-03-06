//this module returns atrbitragable pairs
//Local Modules
const api = require('binance');
const socket = require('socket.io');
const express = require('express');
const cors = require('cors');
const sort = require('fast-sort');
const path = require('path');
require('dotenv').config();
const Big = require('big.js');
const Model = require('../database/models');
const Mutex = require('async-mutex').Mutex;
const mutex = new Mutex();
const fs = require('fs');
const { Op, Sequelize } = require('sequelize');
const { exit } = require('process');
const routes = require('../routes');
const moment = require('moment');
let app,server,io;

const delay = interval => new Promise(resolve => setTimeout(resolve, interval));

const binanceApiKey = process.env.BINANCE_KEY;
const binanceSecretKey = process.env.BINANCE_SECRET;

const binanceRest = new api.BinanceRest({
	key: binanceApiKey, // Get this from your account on binance.com
	secret: binanceSecretKey, // Same for this
	timeout: 15000, // Optional, defaults to 15000, is the request time out in milliseconds
	recvWindow: 10000, // Optional, defaults to 5000, increase if you're getting timestamp errors
	disableBeautification: false,
	handleDrift: true
});

//LOCAL ITEMS
let pairs = [],symValJ={}, filters = {};


//RETURNING ITEMS
let triangle = {
  //pairs:[],//{1:BTC,2:ETH,3:XRP,value:}
  getPairs: async () => {
    const setting = await Model.setting.findOne({
		where: {
			id: 1
		}
    });
    return new Promise((res,rej) => {
        binanceRest.exchangeInfo()
        .then((r1) => {
          let symbols=[],validPairs=[];
          r1.symbols.forEach(d => {
            filters[d.symbol] = {};
			filters[d.symbol].baseAssetPrecision = d['baseAssetPrecision'];
			filters[d.symbol].quoteAssetPrecision = d['quoteAssetPrecision'];
            d.filters.forEach(filter => {
              if (filter['filterType'] === 'LOT_SIZE') {
                filters[d.symbol].LOT_SIZE = filter;
              }
              if (filter['filterType'] === 'MIN_NOTIONAL') {
                filters[d.symbol].MIN_NOTIONAL = filter;
              }
              if (filter['filterType'] === 'MARKET_LOT_SIZE') {
                filters[d.symbol].MARKET_LOT_SIZE = filter;
              }
            });
            if(symbols.indexOf(d.baseAsset) === -1){symbols.push(d.baseAsset);}
            if(symbols.indexOf(d.quoteAsset) === -1){symbols.push(d.quoteAsset);}
            if(d.status === "TRADING"){validPairs.push(d.symbol);symValJ[d.symbol]={bidPrice:0,askPrice:0}}
          });

          //find arbitragable coins
          let s1 = symbols,s2=symbols,s3=symbols;
          //let s1 = [],s2=[],s3=[];
          s1.filter(f1 => f1 === setting.base_coin).forEach(d1 => {
            s2.forEach(d2 => {
              s3.forEach(d3 => {
                if(!(d1 == d2 || d2 == d3 || d3 == d1)){
                  let lv1=[],lv2=[],lv3=[],l1='',l2='',l3='';
                  if(validPairs.indexOf(d1+d2) != -1){
                    lv1.push(d1+d2);
                    l1='num';
                  }
                  if(validPairs.indexOf(d2+d1) != -1){
                    lv1.push(d2+d1);
                    l1='den';
                  }

                  if(validPairs.indexOf(d2+d3) != -1){
                    lv2.push(d2+d3);
                    l2 = 'num';
                  }
                  if(validPairs.indexOf(d3+d2) != -1){
                    lv2.push(d3+d2);
                    l2 = 'den';
                  }

                  if(validPairs.indexOf(d3+d1) != -1){
                    lv3.push(d3+d1);
                    l3='num';
                  }
                  if(validPairs.indexOf(d1+d3) != -1){
                    lv3.push(d1+d3);
                    l3='den';
                  }


                  if(lv1.length && lv2.length && lv3.length){
                    pairs.push({
                      l1:l1,
                      l2:l2,
                      l3:l3,
                      d1:d1,
                      d2:d2,
                      d3:d3,
                      lv1:lv1[0],
                      lv2:lv2[0],
                      lv3:lv3[0],
                      value:-100,
                      tpath:''
                    });
                  }

                }
              });
            });
          });
          res();

        }).catch(err => {
          console.log(err);
        });
    })
  },
  startServer : () => {
    return new Promise((res,rej) => {
		app = express();
		server = app.listen(3000,() => {console.log('Arbitrage Bot has just started on port 3000. Please wait.....');});
		app.use(cors());
		app.use(express.json());
		app.use(express.urlencoded({ extended: true }));
		app.use('/api/', routes);
		io = socket(server).listen(2053);
		io.on('connection', (socket) => {
			console.log(`Client Connected [id=${socket.id}]`);
			socket.emit('success', { message: 'Server Accepting Conncetion' });
		});
      res();
    });
  },
  calculate: async () => {
    console.log('Finished SetUp. Open "http://127.0.0.1:3000/" in your browser to access. Happy Trading!!');
    const fee_percentage = 0.1 * 0.01;
	// const fee_percentage = 0.075 * 0.01;
    let binanceWS = new api.BinanceWS();
	binanceWS.onAllTickers(async (data) => {
		let BNBExchangeRate = 1;
		const setting = await Model.setting.findOne({
			where: {
				id: 1
			}
		});
		
		console.log(setting.is_paused);
		const accountInfo = await binanceRest.account();
		let accountBalance = 0;
		const balanceObj = accountInfo.balances.find(balance => balance.asset === setting.base_coin);
		if (balanceObj) {
			accountBalance = parseFloat(balanceObj['free']) - parseFloat(balanceObj['locked']);
		}
		const date = new Date();
		const statisticsInfo = await Model.trade_transaction.findOne({
			where: Sequelize.where(Sequelize.fn('DATE_FORMAT', Sequelize.col('createdAt'), '%Y-%m-%d'), moment(date).format('YYYY-MM-DD')),
			attributes: [
			[Sequelize.fn('SUM', Sequelize.col('result_profit_amount')), 'result_profit_amount'],
			[Sequelize.fn('COUNT', Sequelize.col('id')), 'order_count']
			]
		});
		const totalProfitInfo = await Model.trade_transaction.findOne({
			attributes: [
			[Sequelize.fn('SUM', Sequelize.col('result_profit_amount')), 'result_profit_amount']
			]
		});
		await io.sockets.emit("ARBITRAGE_STATISTICS",{
			accountCurrency: setting.base_coin,
			accountBalance,
			statisticsInfo,
			totalProfitInfo
		});

		if (setting.is_paused) {
			return;
		}
		if (setting.base_coin !== 'BNB') {
			let priceData = await binanceRest.bookTicker({
				symbol: 'BNB' + setting.base_coin
			});
			if (priceData.hasOwnProperty("code") && priceData.code == -1121) {
				priceData = await binanceRest.bookTicker({
					symbol: setting.base_coin + 'BNB'
				});
				if (priceData.hasOwnProperty("code") && priceData.code == -1121) {
					console.log('No symbols BNB-', setting.base_coin);
					return; 
				} else {
					BNBExchangeRate = 1 / Number(priceData.askPrice);
				}
			} else {
				BNBExchangeRate = Number(priceData.bidPrice);
			}
		}
		console.log('BNBExchangeRate: ', BNBExchangeRate);
		//Update JSON
		data.forEach(d => {
		symValJ[d.symbol].bidPrice = parseFloat(d.bestBid);
		symValJ[d.symbol].askPrice = parseFloat(d.bestAskPrice);
		});
		// await mutex.runExclusive(async () => {
		//Perform calculation and send alerts
		await pairs.filter(d => d.d1 === setting.base_coin).forEach(async d => {
			let total_fee = 0;
			let fee1, fee2, fee3;
			let amount1, amount2, amount3;
			let amount = new Big(setting.init_amount);
			//continue if price is not updated for any symbol
			if(symValJ[d.lv1]["bidPrice"] && symValJ[d.lv2]["bidPrice"] && symValJ[d.lv3]["bidPrice"]){
				amount = module.exports.checkStepSize(d.lv1, amount, d.l1);
				if (module.exports.applyFilters(d.lv1, amount, d.l1, symValJ[d.lv1]["bidPrice"]) != 1) {
					return;
				}
				//Level 1 calculation
				let lv_calc,lv_str;
				if(d.l1 === 'num'){
					lv_calc = symValJ[d.lv1]["bidPrice"];
					// lv_str = d.d1 +  '->' + d.lv1 + "['bidP']['" + symValJ[d.lv1]["bidPrice"] + "']" + '->' + d.d2 + '<br/>';
					amount1 = amount.times(symValJ[d.lv1]["bidPrice"]);
					fee1 = amount1.times(fee_percentage);
					// amount = amount1.minus(fee1);
					total_fee = fee1.div(symValJ[d.lv1]["askPrice"]);
					d.ex_price1 = symValJ[d.lv1]["bidPrice"];
				}
				else{
					lv_calc = 1/symValJ[d.lv1]["askPrice"];
					// lv_str = d.d1 +  '->' + d.lv1 + "['askP']['" + symValJ[d.lv1]["askPrice"] + "']" + '->' + d.d2 + '<br/>';
					amount1 = amount.div(symValJ[d.lv1]["askPrice"]);
					fee1 = amount1.times(fee_percentage);
					// amount = amount1.minus(fee1);
					total_fee = fee1.times(symValJ[d.lv1]["bidPrice"]);
					d.ex_price1 = symValJ[d.lv1]["askPrice"];
				}
				amount1 = module.exports.checkStepSize(d.lv2, amount1, d.l2);
				if (module.exports.applyFilters(d.lv2, amount1, d.l2, symValJ[d.lv2]["bidPrice"]) != 1) {
					return;
				}
				//Level 2 calculation
				if(d.l2 === 'num'){
					lv_calc *= symValJ[d.lv2]["bidPrice"];
					//   lv_str  += d.d2 +  '->' + d.lv2 + "['bidP']['" + symValJ[d.lv2]["bidPrice"] + "']" +  '->' + d.d3+ '<br/>';
					amount2 = amount1.times(symValJ[d.lv2]["bidPrice"]);
					fee2 = amount2.times(fee_percentage);
					// amount = amount2.minus(fee2);
					d.ex_price2 = symValJ[d.lv2]["bidPrice"];
					}
				else{
					lv_calc *= 1/symValJ[d.lv2]["askPrice"];
					//   lv_str  += d.d2 +  '->' + d.lv2 + "['askP']['" + symValJ[d.lv2]["askPrice"] + "']" +  '->' + d.d3 + '<br/>';
					amount2 = amount1.div(symValJ[d.lv2]["askPrice"]);
					fee2 = amount2.times(fee_percentage);
					// amount = amount2.minus(fee2);
					d.ex_price2 = symValJ[d.lv2]["askPrice"];
				}
				// console.log('before amount2', amount2.toNumber());
				amount2 = module.exports.checkStepSize(d.lv3, amount2, d.l3);
				if (module.exports.applyFilters(d.lv3, amount2, d.l3, symValJ[d.lv3]["bidPrice"]) != 1) {
					// console.log('amount2 returned', d.lv3, amount2.toNumber(), d.l3, symValJ[d.lv3]["bidPrice"]);
					return;
				}
				// console.log('after amount2', amount2.toNumber(), d.lv3, d.l3);
				//Level 3 calculation
				if(d.l3 === 'num'){
					total_fee = total_fee.plus(fee2.times(symValJ[d.lv3]["bidPrice"]));

					lv_calc *= symValJ[d.lv3]["bidPrice"];
					//   lv_str  += d.d3 +  '->' + d.lv3 + "['bidP']['" + symValJ[d.lv3]["bidPrice"] + "']" + '->' +  d.d1 ;
					amount3 = amount2.times(symValJ[d.lv3]["bidPrice"]);
					fee3 = amount3.times(fee_percentage);
					// amount = amount3.minus(fee3);
					total_fee = total_fee.plus(fee3);
					d.ex_price3 = symValJ[d.lv3]["bidPrice"];
					}
				else{
					total_fee = total_fee.plus(fee2.div(symValJ[d.lv3]["askPrice"]));

					lv_calc *= 1/symValJ[d.lv3]["askPrice"];
					//   lv_str += d.d3 +  '->' + d.lv3 + "['askP']['" + symValJ[d.lv3]["askPrice"] + "']" + '->' +  d.d1;
					amount3 = amount2.div(symValJ[d.lv3]["askPrice"]);
					fee3 = amount3.times(fee_percentage);
					// amount = amount3.minus(fee3);
					total_fee = total_fee.plus(fee3);
					d.ex_price3 = symValJ[d.lv3]["askPrice"];
				}
				const total_percentage = total_fee.div(amount).times(100);
				d.fee_percentage = total_percentage.toNumber();
				d.value = parseFloat(parseFloat((lv_calc - 1)*100).toFixed(3));
				// d.profit_percentage = d.value - d.fee_percentage;
				// const profitPercentage = d.profit_percentage;
				const profit = amount3.minus(total_fee.plus(amount));
				const profitPercentage = profit.div(amount).times(100);
				d.profit_percentage = profitPercentage.toNumber();
				d.date = new Date();
				d.amount1 = amount;
				d.amount2 = amount1.toNumber();
				d.amount3 = amount2.toNumber();
				d.amount4 = amount3.toNumber();
				d.is_done = false;
				if(profitPercentage >= setting.profit_percentage) {
					let isStop = false;
					console.log(amount.toNumber(), amount1.toNumber(), amount2.toNumber(), amount3.toNumber(), total_fee.toNumber());
					console.log(profitPercentage.toNumber(), total_percentage.toNumber(), d.value, d.value-d.fee_percentage);
					let result1, result2, result3;
					await delay(10);
					await mutex.runExclusive(async () => {
						const customOrderId1 = binanceRest.generateNewOrderId();
						const customOrderId2 = binanceRest.generateNewOrderId();
						const customOrderId3 = binanceRest.generateNewOrderId();
					
						let quantity1 = new Big(amount.toFixed(8));
						let quantity2 = new Big(amount1.toFixed(8));
						let quantity3 = new Big(amount2.toFixed(8));
						let quantity4 = 0;
						let resultProfitAmount = 0, realProfitPercentage = 0;
						let resultFeeAmount = new Big(0), resultFeePercentage = new Big(0);

						try {
							const accountInfo = await binanceRest.account();
							const balanceObj = accountInfo.balances.find(balance => balance.asset === d.d1);
							if (balanceObj) {
								const balance = new Big(balanceObj['free']).minus(balanceObj['locked']);
								if (balance.cmp(quantity1) < 0) {
									quantity1 = balance;
								}
							}
							quantity1 = module.exports.checkStepSize(d.lv1, quantity1, d.l1);
							let filterStatus = module.exports.applyFilters(d.lv1, quantity1, d.l1, symValJ[d.lv1]["bidPrice"]);
							if (!isStop && filterStatus == 1) {
								if (d.l1 === 'num') {
									result1 = await binanceRest.testOrder({
										symbol: d.lv1,
										quantity: quantity1.toNumber(),
										side: 'SELL',
										type: 'MARKET',
										newClientOrderId: customOrderId1,
									});
								} else {
									result1 = await binanceRest.testOrder({
										symbol: d.lv1,
										quoteOrderQty: quantity1.toNumber(),
										side: 'BUY',
										type: 'MARKET',
										newClientOrderId: customOrderId1,
									});
								}
								console.log('result1 finished-', JSON.stringify(result1, null, 4));
							} else {
								isStop = true;
								console.log('filter test error1-', {
									status: filterStatus == 2 ? 'LOT_SIZE' : 'MIN_NOTIONAL',
									symbol: d.lv1,
									type: d.l1 === 'num' ? 'SELL' : 'BUY',
									amount: quantity1.toNumber(),
									bidPrice: symValJ[d.lv1]["bidPrice"],
									minNotional: filters[d.lv1]['MIN_NOTIONAL']['minNotional']
								})
								return;
							}
						} catch(err) {
						console.log('result1 test-err');
						console.log(err);
						console.log({
							symbol: d.lv1,
							amount: quantity1.toNumber(),
							side: d.l1 === 'num' ? 'SELL' : 'BUY',
							bidPrice: symValJ[d.lv1]["bidPrice"],
							type: 'MARKET',
							minNotional: filters[d.lv1]['MIN_NOTIONAL']['minNotional']
						});
						isStop = true;
						return;
						}
						try {
							quantity2 = module.exports.checkStepSize(d.lv2, quantity2, d.l2);
							let filterStatus = module.exports.applyFilters(d.lv2, quantity2, d.l2, symValJ[d.lv2]["bidPrice"]);
							if (!isStop && filterStatus == 1) {
								if (d.l2 === 'num') {
									result2 = await binanceRest.testOrder({
										symbol: d.lv2,
										quantity: quantity2.toNumber(),
										side: 'SELL',
										type: 'MARKET',
										newClientOrderId: customOrderId2,
									});
								} else {
									result2 = await binanceRest.testOrder({
										symbol: d.lv2,
										quoteOrderQty: quantity2.toNumber(),
										side: 'BUY',
										type: 'MARKET',
										newClientOrderId: customOrderId2,
									});
								}
								console.log('result2 finished-', JSON.stringify(result2, null, 4));
							} else {
								isStop = true;
								console.log('filter test error2-', {
									status: filterStatus == 2 ? 'LOT_SIZE' : 'MIN_NOTIONAL',
									type: d.l2 === 'num' ? 'SELL' : 'BUY',
									symbol: d.lv2,
									amount: quantity2.toNumber(),
									bidPrice: symValJ[d.lv2]["bidPrice"],
									minNotional: filters[d.lv2]['MIN_NOTIONAL']['minNotional']
								})
								return;
							}
						} catch(err) {
						console.log('result2 test-err');
						console.log(err);
						console.log({
							symbol: d.lv2,
							amount: quantity2.toNumber(),
							side: d.l2 === 'num' ? 'SELL' : 'BUY',
							bidPrice: symValJ[d.lv2]["bidPrice"],
							type: 'MARKET',
							minNotional: filters[d.lv2]['MIN_NOTIONAL']['minNotional']
						});
						isStop = true;
						return;
						}
						try{
							quantity3 = module.exports.checkStepSize(d.lv3, quantity3, d.l3);
							let filterStatus = module.exports.applyFilters(d.lv3, quantity3, d.l3, symValJ[d.lv3]["bidPrice"]);
							if (!isStop && filterStatus == 1) {
								if (d.l3 === 'num') {
									result3 = await binanceRest.testOrder({
										symbol: d.lv3,
										quantity: quantity3.toNumber(),
										side: 'SELL',
										type: 'MARKET',
										newClientOrderId: customOrderId3,
									});
								} else {
									result3 = await binanceRest.testOrder({
										symbol: d.lv3,
										quoteOrderQty: quantity3.toNumber(),
										side: 'BUY',
										type: 'MARKET',
										newClientOrderId: customOrderId3,
									});
								}
								console.log('result3 finished-', JSON.stringify(result3, null, 4));
							} else {
								isStop = true;
								console.log('filter test error3-', {
									status: filterStatus == 2 ? 'LOT_SIZE' : 'MIN_NOTIONAL',
									type: d.l3 === 'num' ? 'SELL' : 'BUY',
									amount: quantity3.toNumber(),
									symbol: d.lv3,
									bidPrice: symValJ[d.lv3]["bidPrice"],
									minNotional: filters[d.lv3]['MIN_NOTIONAL']['minNotional']
								})
								return;
							}
						} catch(err) {
						console.log('result3 test-err');
						console.log(err);
						console.log({
							symbol: d.lv3,
							amount: quantity3.toNumber(),
							side: d.l3 === 'num' ? 'SELL' : 'BUY',
							bidPrice: symValJ[d.lv3]["bidPrice"],
							type: 'MARKET',
							minNotional: filters[d.lv3]['MIN_NOTIONAL']['minNotional']
						});
						isStop = true;
						return;
						}

						if (!isStop) {
						try {
							const accountInfo = await binanceRest.account();
							const balanceObj = accountInfo.balances.find(balance => balance.asset === d.d1);
							if (balanceObj) {
								const balance = new Big(balanceObj['free']).minus(balanceObj['locked']);
								if (balance.cmp(quantity1) < 0) {
									quantity1 = balance;
								}
							}
							quantity1 = module.exports.checkStepSize(d.lv1, quantity1, d.l1);
							let filterStatus = module.exports.applyFilters(d.lv1, quantity1, d.l1, symValJ[d.lv1]["bidPrice"]);
							if (filterStatus == 1) {
								if (d.l1 === 'num') {
									result1 = await binanceRest.newOrder({
										symbol: d.lv1,
										quantity: quantity1.toNumber(),
										side: 'SELL',
										type: 'MARKET',
										newClientOrderId: customOrderId1,
									});
								} else {
									result1 = await binanceRest.newOrder({
										symbol: d.lv1,
										quoteOrderQty: quantity1.toNumber(),
										side: 'BUY',
										type: 'MARKET',
										newClientOrderId: customOrderId1,
									});
								}
								console.log('result1-', JSON.stringify(result1, null, 4));
							} else {
								console.log('filter error1-', {
									status: filterStatus == 2 ? 'LOT_SIZE' : 'MIN_NOTIONAL',
									type: d.l1 === 'num' ? 'SELL' : 'BUY',
									amount: quantity1.toNumber(),
									symbol: d.lv1,
									bidPrice: symValJ[d.lv1]["bidPrice"],
									minNotional: filters[d.lv1]['MIN_NOTIONAL']['minNotional']
								})
								return;
							}
						} catch(err) {
							console.log('result1-err');
							console.log(err);
							console.log({
							symbol: d.lv1,
							amount: quantity1.toNumber(),
							side: d.l1 === 'num' ? 'SELL' : 'BUY',
							type: 'MARKET',
							minNotional: filters[d.lv1]['MIN_NOTIONAL']['minNotional']
							});
							return;
						}
						try {
							quantity1 = new Big(d.l1 === 'num' ? result1.executedQty : result1.cummulativeQuoteQty);
							result1.fills.forEach(commissionAry => {
								resultFeeAmount = resultFeeAmount.plus(commissionAry.commission);
							})
							quantity2 = new Big(d.l1 === 'num' ? result1.cummulativeQuoteQty : result1.executedQty);
							quantity2 = module.exports.checkStepSize(d.lv2, quantity2, d.l2);
							let filterStatus = module.exports.applyFilters(d.lv2, quantity2, d.l2, symValJ[d.lv2]["bidPrice"]);
							if (filterStatus == 1) {
								if (d.l2 === 'num') {
									result2 = await binanceRest.newOrder({
										symbol: d.lv2,
										quantity: quantity2.toNumber(),
										side: 'SELL',
										type: 'MARKET',
										newClientOrderId: customOrderId2,
									});
								} else {
									result2 = await binanceRest.newOrder({
										symbol: d.lv2,
										quoteOrderQty: quantity2.toNumber(),
										side: 'BUY',
										type: 'MARKET',
										newClientOrderId: customOrderId2,
									});
								}
								console.log('result2-', JSON.stringify(result2, null, 4));
							} else {
								console.log('filter error2-', {
									status: filterStatus == 2 ? 'LOT_SIZE' : 'MIN_NOTIONAL',
									type: d.l2 === 'num' ? 'SELL' : 'BUY',
									amount: quantity2.toNumber(),
									symbol: d.lv2,
									bidPrice: symValJ[d.lv2]["bidPrice"],
									minNotional: filters[d.lv2]['MIN_NOTIONAL']['minNotional']
								})
								return;
							}
						} catch(err) {
							console.log('result2-err');
							console.log(err);
							console.log({
								symbol: d.lv2,
								amount: quantity2.toNumber(),
								side: d.l2 === 'num' ? 'SELL' : 'BUY',
								type: 'MARKET',
								minNotional: filters[d.lv2]['MIN_NOTIONAL']['minNotional']
							});
							return;
						}
						try{
							result2.fills.forEach(commissionAry => {
								resultFeeAmount = resultFeeAmount.plus(commissionAry.commission);
							})
							quantity3 = new Big(d.l2 === 'num' ? result2.cummulativeQuoteQty : result2.executedQty);
							quantity3 = module.exports.checkStepSize(d.lv3, quantity3, d.l3);
							let filterStatus = module.exports.applyFilters(d.lv3, quantity3, d.l3, symValJ[d.lv3]["bidPrice"]);
							if (filterStatus == 1) {
								if (d.l3 === 'num') {
									result3 = await binanceRest.newOrder({
										symbol: d.lv3,
										quantity: quantity3.toNumber(),
										side: 'SELL',
										type: 'MARKET',
										newClientOrderId: customOrderId3,
									});
								} else {
									result3 = await binanceRest.newOrder({
										symbol: d.lv3,
										quoteOrderQty: quantity3.toNumber(),
										side: 'BUY',
										type: 'MARKET',
										newClientOrderId: customOrderId3,
									});
								}
								console.log('result3-', JSON.stringify(result3, null, 4));
							} else {
								console.log('filter error3-', {
									status: filterStatus == 2 ? 'LOT_SIZE' : 'MIN_NOTIONAL',
									type: d.l3 === 'num' ? 'SELL' : 'BUY',
									amount: quantity3.toNumber(),
									symbol: d.lv3,
									bidPrice: symValJ[d.lv3]["bidPrice"],
									minNotional: filters[d.lv3]['MIN_NOTIONAL']['minNotional']
								})
								return;
							}
						} catch(err) {
							console.log('result3-err');
							console.log(err);
							console.log({
								symbol: d.lv3,
								amount: quantity3.toNumber(),
								side: d.l3 === 'num' ? 'SELL' : 'BUY',
								type: 'MARKET',
								minNotional: filters[d.lv3]['MIN_NOTIONAL']['minNotional']
							});
							return;
						}
						quantity4 = new Big(d.l3 === 'num' ? result3.cummulativeQuoteQty : result3.executedQty);
						resultFeeAmount = resultFeeAmount.times(BNBExchangeRate);
						resultFeePercentage = resultFeeAmount.div(quantity1).times(100);
						resultProfitAmount = quantity4.minus(quantity1.plus(resultFeeAmount));
						realProfitPercentage = resultProfitAmount.div(quantity1).times(100);
						console.log('result is:', resultProfitAmount.toNumber(), realProfitPercentage.toNumber(), resultFeeAmount.toNumber(), resultFeePercentage.toNumber(), quantity4.toNumber(), quantity1.toNumber());
						const trade = await Model.trade_transaction.create({
							symbol1: d.d1,
							symbol2: d.d2,
							symbol3: d.d3,
							first_pair: d.lv1,
							first_pair_type: d.l1 === 'num' ? 'sell' : 'buy',
							first_exchange_price: d.l1 === 'num' ? symValJ[d.lv1]["bidPrice"] : symValJ[d.lv1]["askPrice"],
							first_symbol1_amount: d.l1 === 'num' ? result1.executedQty : result1.cummulativeQuoteQty,
							first_symbol2_amount: d.l1 === 'num' ? result1.cummulativeQuoteQty : result1.executedQty,
							second_pair: d.lv2,
							second_pair_type: d.l2 === 'num' ? 'sell' : 'buy',
							second_exchange_price: d.l2 === 'num' ? symValJ[d.lv2]["bidPrice"] : symValJ[d.lv2]["askPrice"],
							second_symbol1_amount: d.l2 === 'num' ? result2.executedQty : result2.cummulativeQuoteQty,
							second_symbol2_amount: d.l2 === 'num' ? result2.cummulativeQuoteQty : result2.executedQty,
							third_pair: d.lv3,
							third_pair_type: d.l3 === 'num' ? 'sell' : 'buy',
							third_exchange_price: d.l3 === 'num' ? symValJ[d.lv3]["bidPrice"] : symValJ[d.lv3]["askPrice"],
							third_symbol1_amount: d.l3 === 'num' ? result3.executedQty : result3.cummulativeQuoteQty,
							third_symbol2_amount: d.l3 === 'num' ? result3.cummulativeQuoteQty : result3.executedQty,
							fee_amount: total_fee.toNumber(),
							fee_percentage: total_percentage.toNumber(),
							result_fee_amount: resultFeeAmount.toNumber(),
							result_fee_percentage: resultFeePercentage.toNumber(),
							profit_amount: profit.toNumber(),
							profit_percentage: profitPercentage.toNumber(),
							result_profit_amount: resultProfitAmount.toNumber(),
							result_profit_percentage: realProfitPercentage.toNumber()
						});
						d.is_done = true;
						}
					});
				}
			}
		});
		// });
		//Send Socket
		await io.sockets.emit("ARBITRAGE",sort(pairs.filter(d => d.d1 === setting.base_coin && d.value > 0)).desc(u => u.value));
	});
  },
  test: async () => {
    try {
      console.log('Finished test. Open "http://127.0.0.1:3000/" in your browser to access. Happy Trading!!');
      const binanceRest = new api.BinanceRest({
          key: binanceApiKey, // Get this from your account on binance.com
          secret: binanceSecretKey, // Same for this
          timeout: 15000, // Optional, defaults to 15000, is the request time out in milliseconds
          recvWindow: 10000, // Optional, defaults to 5000, increase if you're getting timestamp errors
          disableBeautification: false,
          handleDrift: true
      });
      // const result1 = await binanceRest.account();
      const customOrderId = binanceRest.generateNewOrderId();
      try {
        const result1 = await binanceRest.testOrder({
            symbol: 'MATICBUSD',
            quantity: 8,
            // quoteOrderQty: 9,
            side: 'SELL',
            type: 'MARKET',
            newClientOrderId: customOrderId,
        });
        console.log(JSON.stringify(result1, null, 4));
      } catch(err) {
        console.log('-errr-');
        console.log(err);
      }
    } catch (err) {
      console.log(err);
    };
  },
  applyFilters (symbol, amount, type, bidPrice) {
	  amount = amount.toNumber();
	const minQty1 = Number(filters[symbol]['LOT_SIZE']['minQty']);
	const maxQty1 = Number(filters[symbol]['LOT_SIZE']['maxQty']);
	const minQty2 = filters[symbol].hasOwnProperty('MARKET_LOT_SIZE') ? Number(filters[symbol]['MARKET_LOT_SIZE']['minQty']) : 0;
	const maxQty2 = filters[symbol].hasOwnProperty('MARKET_LOT_SIZE') ? Number(filters[symbol]['MARKET_LOT_SIZE']['maxQty']) : 9999999;
	const minNotional = Number(filters[symbol]['MIN_NOTIONAL']['minNotional']);
	if (type === 'num') {
		if (amount >= minQty1 && amount <= maxQty1 && 
			amount >= minQty2 && amount <= maxQty2) {
				if (amount*bidPrice >= minNotional) {
					return 1;
				} else {
					return 3;
				}
		} else {
			return 2;
		}
	} else {
		if (amount >= minNotional) {
			return 1;			
		} else {
			return 3;
		}
	}
  },
  checkStepSize (symbol, quantity, type) {
	if (type === 'num') {
		if (Number(filters[symbol]['LOT_SIZE']['stepSize']) != 0) {
			let restValue = quantity.minus(+filters[symbol]['LOT_SIZE']['minQty']).mod(+filters[symbol]['LOT_SIZE']['stepSize']);
			if (restValue.toNumber() != 0) {
				quantity = quantity.minus(restValue);
			}
		}
	} else {
		quantity = new Big(quantity.toFixed(filters[symbol]['quoteAssetPrecision']));
	}
	return quantity;
  },
  log: () => {
    return pairs.length;
  }
}

//PROCEDURE
//GET ALL SYMBOLS AND IDENTIFY ARBITRAGABLE COINS
//OPEN SOCKET FOR 24 HOURS STATS
//CALCULATE AND SEND THE BEST ARB OPPORTUNITIES EVERY SEC

module.exports = triangle;
