const parser = require('rss-parser');
const moment = require('moment');
const axios = require('axios');
const request = require('request');
const schedule = require('node-schedule');
const bunyan = require('bunyan');
const mapLimit = require('async/mapLimit');
const timeout = require('async/timeout');
const jueJinCrawler = require('./juejinCrawler');
const Helpers = require('../utils/helpers');
const _ = require('lodash');
const dbOperate = require('../utils/rssDbOperate');
const issueOperate = require('../utils/createIssue');

import Base from '../api/base';


module.exports = {
    bootstrap: bootstrap
}


const log = bunyan.createLogger({
    name: 'rss schedule'
});

// mongodb 中存储的 RSS 源列表
let sourceList = [];

// 初始值为 sourceList 的深拷贝版本，用于循环抓取中使用
// 存放待抓取的源列表
let toFetchList = [];

// 抓取时间
let fetchStartTime = null;

// 记录中的上次抓取时间
let lastFetchTime = null;

// 抓取次数
let fetchTimes = 0;

// 抓取定时器 ID
let fetchInterval = null;

// Boolean 是否为周汇总推送
let isWeeklyTask = false;

// Boolean 抓取状态标志
let done = false;

// 筛选过，待发送的推送数据列表
let pushList = [];

// 文章数 count
let count = 0;

// 免扰日
let silentWeekDays = [6, 0];

// 周汇总 issue 地址
let weeklyUrl = '';

// jwt token
let token = '';

function bootstrap () {
    // 登录获取 token
    Base.login({
        userName: process.argv[3],
        pwd: process.argv[4],
    })
    .then((res) => {
        if (res && res.data && res.data.success) {
            token = res.data.token;
            setPushSchedule();
            // activateFetchTask();
        }
    })
}

function setPushSchedule () {
    schedule.scheduleJob('00 30 09 * * *', () => {
        // 抓取任务
        log.info('rss schedule fetching fire at ' + new Date());
        isWeeklyTask = false;
        activateFetchTask();
    });

    schedule.scheduleJob('00 00 10 * * *', () => {
        if (sourceList.length && !silentWeekDays.includes(moment().weekday())) {
            // 发送任务
            log.info('rss schedule delivery fire at ' + new Date());
            isWeeklyTask = false;
            if (pushList.length) {
                let message = makeUpMessage();
                log.info(message);
                // TODO 正式上线前恢复
                // sendToWeChat(message);
            }
        }
    });

    schedule.scheduleJob('00 16 10 * * 5', () => {
        if (sourceList.length) {
            // Weekly 抓取任务
            log.info('rss schedule weekly fire at ' + new Date());
            isWeeklyTask = true;
            activateFetchTask();
        }
    });
}

function activateFetchTask () {
    axios.all([Base.fetchSourceList(), Base.fetchPushHistory(token)])
        .then(axios.spread((source, history) => {
            // 获取历史信息
            // 得到上次推送的具体时间与一周内的文章数据
            if (history && history.data && history.data.list) {
                handlePushHistory(history.data.list);
            } else {
                lastFetchTime = moment().subtract(1, 'days');
            }
            if (source.data && source.data.list && source.data.list.length) {
                handleSouceList(source.data.list);
            }
        }));
}

const handlePushHistory = (list) => {
    let lastPushItem = null;
    lastPushItem = list[0];
    if (isWeeklyTask) {
        lastPushItem = list.find((item) => item.type === 'weekly');
    }
    lastFetchTime = lastPushItem ?
        lastPushItem.time :
        moment().subtract(1, 'days');
}

const handleSouceList = (list) => {
    sourceList = list;
    toFetchList = _.cloneDeep(sourceList);
    log.info('rss源站共' + sourceList.length);
    if (sourceList.length && !silentWeekDays.includes(moment().weekday())) {
        fetchStartTime = moment().format('YYYY-MM-DD HH:mm:ss');
        log.info('rss real fetching time is' + fetchStartTime);
        launch();
    }
}

const fetchRSSUpdate = function () {
    fetchTimes++;
    if (fetchTimes > 1) {
        // 过滤掉抓取成功的源
        toFetchList = toFetchList.filter((item) => !_.isNull(item));
    }
    if (toFetchList.length && fetchTimes < 4) {
        // 若抓取次数少于三次，且仍存在未成功抓取的源
        log.info(`第${fetchTimes}次抓取，有 ${toFetchList.length} 篇`);
        // 最大并发数为10，超时时间设置为 5000ms
        return mapLimit(toFetchList, 15, (source, callback) => {
            timeout(parseCheck(source, callback), 8000);
        })
    }
    log.info('fetching is done');
    clearInterval(fetchInterval);
    // 发送前以数据源的 url 为主键进行去重
    pushList = _.uniqBy(pushList, 'url');
    return fetchDataCb();
}

const parseFunction = function (source) {
    return new Promise((resolve, reject) => {
        parser.parseURL(source.url, function (err, parsed) {
            if (err) {
                log.warn(`${source.title}出错：${err}`);
                reject(err);
            } else {
                resolve(parsed);
            }
        })
    })
}

async function parseCheck (source, callback) {
    let parsed = null;
    try {
        parsed = await parseFunction(source);
        if (parsed && parsed.feed && parsed.feed.entries.length &&
            UpdateAfterLastPush(parsed.feed.entries).length) {
            // 筛出更新时间满足条件的文章
            // RSS 源的文章限制最多五篇
            // 避免由于源不稳定造成的推送过多
            let articlesUpdateAfterLastPush = UpdateAfterLastPush(parsed.feed.entries).slice(0, 5);
            log.info(`${source.title} 今天有新文章 ${articlesUpdateAfterLastPush.length} 篇`)
            const result = Object.assign({}, source, { list: articlesUpdateAfterLastPush });
            count = count + articlesUpdateAfterLastPush.length;
            pushList.push(result);
        } else {
            log.info(`${source.title} 今天有新文章0篇`);
        }
        // 删掉 toFetchList 中已抓取成功的源
        const index = _.findIndex(toFetchList, (item) => item && item.url === source.url);
        toFetchList[index] = null;
        callback();
    } catch (e) {
        callback();
    }
}

const UpdateAfterLastPush = function (entries) {
    let result = [];
    let list = entries.concat([]);
    while (list[0] && list[0].pubDate && isPubDateMatch(list[0].pubDate)) {
        result.push(list[0]);
        list.shift();
    }
    return result;
}

const isPubDateMatch = (pubDate) => {
    const timestamp = Date.parse(pubDate);
    return moment(timestamp).isAfter(lastFetchTime);
}

const makeUpMessage = function () {
    let msg = '';
    if (!pushList.length) {
        msg = '暂时还没有新增文章~';
    } else {
        msg += `新鲜货${count}篇\n\n`;
        if (moment().weekday() === 5 && weeklyUrl) {
            msg += `周末愉快~\n\n[本周推送汇总](${weeklyUrl})已生成\n\n`;
        }
        pushList.forEach((push, index) => {
            msg += `${index}.${push.title} | ${push.list.length}篇 \n\n`;
            push.list.forEach((article) => {
                msg += `[${article.title}](${article.link})\n\n`;
            })
        })
        msg += '历史推送可在[周推送汇总](https://github.com/MechanicianW/little-robot/issues)查看';
    }
    return Helpers.filterEmoji(msg);
}


const sendToWeChat = function (message) {
    request.post({
        url: 'https://pushbear.ftqq.com/sub?sendkey=1569-b7bcd67b825bb46ece65ce8ed68d045f',
        form: {
            text: '今日推送',
            desp: message
        }
    }, function (error, response, body) {
        log.error('error:', error);
        log.info('statusCode:', response && response.statusCode);
        log.info('body:', body);
    });
}


const fetchDataCb = (err, result) => {
    // 数据源抓取完成的回调函数
    if (done) {
        return;
    }
    done = true;
    clearInterval(fetchInterval);
    log.info('fetching callback');
    if (pushList.length) {
        // 抓取完成 推送日志
        // 按抓取源权重排序
        pushList = _.orderBy(pushList, 'weight', 'desc');
        let message = makeUpMessage();
        if (moment().weekday() === 5 && isWeeklyTask) {
            issueOperate.createIssue(`${moment().subtract(7, 'days').format('YYYY-MM-DD')} ~ ${moment().format('YYYY-MM-DD')}`, message)
                .then((res) => {
                    weeklyUrl = res || '';
                })
        }
        Helpers.sendLogs(message);
        const allArticles = _.flatten(_.map(pushList, 'list'));
        Base.insertPushHistory({
            type: isWeeklyTask ? 'weekly' : 'daily',
            time: fetchStartTime,
            content: message,
            articles: _.map(allArticles, (arctile) => _.pick(arctile, ['title', 'link']))
        }, token);
    }
    if (err) {
        log.warn(err);
    }
}

const launch = function () {
    pushList = [];
    count = 0;
    // 重置循环抓取的相关变量
    toFetchList = _.cloneDeep(sourceList);
    done = false;
    fetchTimes = 0;
    jueJinCrawler.fetchAndFilterJueJinUpdate(fetchStartTime, lastFetchTime)
        .then((res) => {
            log.info(`掘金 今天有新文章${res.list.length}篇`);
            if (res.list && res.list.length) {
                pushList = pushList.concat(res);
                count += res.list.length;
            }
            // // 设置循环抓取定时器，每隔两分钟抓取一次
            // fetchInterval = setInterval(fetchRSSUpdate, 120000);
            // fetchRSSUpdate();
        })
}