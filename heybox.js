/*
 * 小黑盒每日签到 for Surge
 *
 * 版本: v1.0.0
 *
 * 一个文件承担三种脚本类型, 靠入参判别:
 *   $request 存在            -> MITM 抓包, 录入账号与设备参数
 *   $input.purpose=panel     -> 渲染信息面板
 *   其余 (cron)              -> 执行签到
 *
 * 存储键:
 *   HEYBOX_ACCOUNTS   heybox_id#pkey=..;x_xhh_tokenid=..   多账号用 & 分隔
 *   HEYBOX_DEVICE     抓包得到的设备参数 JSON
 *   HEYBOX_STATE      最近一次运行结果 JSON (面板读取)
 *   HEYBOX_HKEY_API   可选, 覆盖默认 hkey 服务地址
 *
 * 本地自测 (不发送任何账号请求):
 *   HEYBOX_ACCOUNTS='123456#pkey=x;x_xhh_tokenid=y' node heybox.js --dry-run
 *
 * 接口流程参考 yowiv08/heybox 与 zpiz/scripts, 签名由第三方 hkey 服务提供。
 * 仅供学习交流, 请自行承担使用风险并遵守平台规则。
 */

"use strict";

var VERSION = "1.0.0";
var DEFAULT_HKEY_API = "https://hkey.qcciii.com/hkey";
var API_BASE = "https://api.xiaoheihe.cn";

var PATH_LIST = "/task/list_v2/";
var PATH_SIGN = "/task/sign_v3/sign";
var PATH_STATE = "/task/sign_v3/get_sign_state";

var KEY_ACCOUNTS = "HEYBOX_ACCOUNTS";
var KEY_DEVICE = "HEYBOX_DEVICE";
var KEY_STATE = "HEYBOX_STATE";
var KEY_HKEY_API = "HEYBOX_HKEY_API";

var UA_APP =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/41.0.2272.118 Safari/537.36 ApiMaxJia/1.0";
var REFERER_APP = "http://api.maxjia.com/";

var DEVICE_DEFAULTS = {
  os_type: "Android",
  x_os_type: "Android",
  x_client_type: "mobile",
  os_version: "12",
  dw: "360",
  channel: "heybox",
  x_app: "heybox",
  time_zone: "Asia/Shanghai",
  device_info: "HBP-AL00"
};
var DEVICE_KEYS = [
  "lang", "device_info", "device_id", "x_app", "os_type", "x_os_type",
  "x_client_type", "os_version", "version", "dw", "time_zone", "channel",
  "build", "imei"
];

// 抓包拿不到 imei 时的兜底值, 与既有实现保持一致
var IMEI_FALLBACK = "4187fb55b1be198a";
// Surge 的 $httpClient timeout 单位是秒
var REQUEST_TIMEOUT = 12;
var SIGN_SETTLE_MS = 1500;
var SIGN_STATE_RETRIES = 3;

var isNode =
  typeof process !== "undefined" &&
  typeof process.versions !== "undefined" &&
  typeof $httpClient === "undefined";

var isDryRun =
  isNode &&
  typeof process.argv !== "undefined" &&
  process.argv.indexOf("--dry-run") >= 0;

// ---------------------------------------------------------------- 宿主适配

function getStore(key) {
  if (typeof $persistentStore !== "undefined") return $persistentStore.read(key);
  if (typeof $prefs !== "undefined") return $prefs.valueForKey(key);
  if (isNode) return process.env[key] || "";
  return "";
}

function setStore(value, key) {
  if (typeof $persistentStore !== "undefined") return $persistentStore.write(value, key);
  if (typeof $prefs !== "undefined") return $prefs.setValueForKey(value, key);
  return false;
}

function notify(title, subtitle, body) {
  if (typeof $notification !== "undefined") {
    $notification.post(title, subtitle, body);
    return;
  }
  if (typeof $notify !== "undefined") {
    $notify(title, subtitle, body);
    return;
  }
  console.log("[" + title + "] " + subtitle + " " + body);
}

function log(message) {
  console.log(message);
}

function done(payload) {
  if (typeof $done === "function") $done(payload || {});
}

function httpGet(url, headers) {
  return new Promise(function (resolve) {
    // dry-run 仍真实请求 hkey 服务(可验证签名接口), 但不触碰任何账号接口
    if (isDryRun && url.indexOf(hkeyApi()) !== 0) {
      console.log("[dry-run] 跳过 " + url);
      resolve(null);
      return;
    }
    if (typeof $httpClient !== "undefined") {
      $httpClient.get(
        { url: url, headers: headers, timeout: REQUEST_TIMEOUT },
        function (error, response, data) {
          if (error) {
            resolve(null);
            return;
          }
          resolve(typeof data === "string" ? data : response ? response.body : null);
        }
      );
      return;
    }
    if (isNode) {
      fetch(url, { headers: headers })
        .then(function (response) {
          return response.text();
        })
        .then(function (text) {
          resolve(text);
        })
        .catch(function (error) {
          log("[node] 请求失败 " + url + " " + error.message);
          resolve(null);
        });
      return;
    }
    resolve(null);
  });
}

function httpGetJson(url, headers) {
  return httpGet(url, headers).then(function (text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  });
}

// ---------------------------------------------------------------- 工具

function query(object) {
  var parts = [];
  Object.keys(object).forEach(function (key) {
    var value = object[key];
    if (value === undefined || value === null || value === "") return;
    parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(value)));
  });
  return parts.join("&");
}

function parseQuery(url) {
  var out = {};
  var index = String(url || "").indexOf("?");
  if (index < 0) return out;
  String(url)
    .slice(index + 1)
    .split("&")
    .forEach(function (item) {
      if (!item) return;
      var pos = item.indexOf("=");
      var key = pos < 0 ? item : item.slice(0, pos);
      var value = pos < 0 ? "" : item.slice(pos + 1);
      if (out[key] === undefined) {
        try {
          out[key] = decodeURIComponent(value);
        } catch (error) {
          out[key] = value;
        }
      }
    });
  return out;
}

function headerValue(headers, name) {
  var wanted = String(name).toLowerCase();
  var keys = Object.keys(headers || {});
  for (var i = 0; i < keys.length; i += 1) {
    if (keys[i].toLowerCase() === wanted) return headers[keys[i]];
  }
  return "";
}

function cookieItem(cookie, name) {
  var items = String(cookie || "").split(";");
  for (var i = 0; i < items.length; i += 1) {
    var item = items[i].trim();
    var pos = item.indexOf("=");
    if (pos < 0) continue;
    if (item.slice(0, pos).trim() === name) return item.slice(pos + 1).trim();
  }
  return "";
}

function randomString(length) {
  var chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  var out = "";
  while (out.length < length) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, Math.max(0, ms));
  });
}

function safeParse(text, fallback) {
  if (!text) return fallback;
  try {
    var value = JSON.parse(text);
    return value && typeof value === "object" ? value : fallback;
  } catch (error) {
    return fallback;
  }
}

function text(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function mask(value) {
  return text(value).replace(/pkey=[^;]+/gi, "pkey=<redacted>").replace(/x_xhh_tokenid=[^;]+/gi, "x_xhh_tokenid=<redacted>");
}

function nowText() {
  var date = new Date();
  function pad(value) {
    return value < 10 ? "0" + value : String(value);
  }
  return (
    date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
    " " + pad(date.getHours()) + ":" + pad(date.getMinutes())
  );
}

function today() {
  return nowText().slice(0, 10);
}

// ---------------------------------------------------------------- 账号与设备

function parseAccounts(raw) {
  var out = [];
  String(raw || "")
    .replace(/\r/g, "\n")
    .split(/[&\n]+/)
    .forEach(function (piece) {
      var item = piece.trim();
      if (!item || item.indexOf("#") < 0) return;
      var parts = item.split("#");
      var heyboxId = parts[0].trim();
      var cookie = parts.slice(1).join("#");
      var pkey = cookieItem(cookie, "pkey");
      var tokenId = cookieItem(cookie, "x_xhh_tokenid");
      if (!heyboxId || !pkey || !tokenId) return;
      var normalized = heyboxId + "#pkey=" + pkey + ";x_xhh_tokenid=" + tokenId;
      if (out.indexOf(normalized) < 0) out.push(normalized);
    });
  return out;
}

function toAccount(item) {
  var parts = item.split("#");
  return { heyboxId: parts[0], cookie: parts.slice(1).join("#") };
}

function readDevice() {
  var captured = safeParse(getStore(KEY_DEVICE), {});
  var merged = {};
  Object.keys(DEVICE_DEFAULTS).forEach(function (key) {
    merged[key] = DEVICE_DEFAULTS[key];
  });
  Object.keys(captured || {}).forEach(function (key) {
    if (captured[key] !== undefined && captured[key] !== null && String(captured[key]) !== "") {
      merged[key] = captured[key];
    }
  });
  if (!merged.imei) merged.imei = IMEI_FALLBACK;
  return merged;
}

function hkeyApi() {
  return text(getStore(KEY_HKEY_API)) || DEFAULT_HKEY_API;
}

// ---------------------------------------------------------------- 接口

function fetchHkey(heyboxId, imei, path, timeSec) {
  var url =
    hkeyApi() +
    "?" +
    query({
      mode: "request",
      path: path,
      time: String(timeSec),
      imei: imei,
      heybox_id: heyboxId
    });
  return httpGetJson(url, { "User-Agent": UA_APP, Accept: "application/json" }).then(function (payload) {
    if (!payload) return { error: "hkey 服务无响应" };
    if (payload.status && payload.status !== "ok") {
      return { error: "hkey 服务返回 " + payload.status + " " + text(payload.msg) };
    }
    var result = payload.result && typeof payload.result === "object" ? payload.result : payload;
    if (!result || !result.hkey) return { error: "hkey 服务未返回 hkey" };
    return {
      hkey: text(result.hkey),
      version: text(result.version),
      build: text(result.build)
    };
  });
}

// hkey 由 path/time/imei/heybox_id 四者绑定, 请求时这四项必须与取签名时完全一致
function signedQuery(account, device, hkey, timeSec, extra) {
  var params = {
    heybox_id: account.heyboxId,
    imei: device.imei,
    device_info: device.device_info,
    nonce: randomString(32),
    hkey: hkey.hkey,
    os_type: device.os_type,
    x_os_type: device.x_os_type,
    x_client_type: device.x_client_type,
    os_version: device.os_version,
    version: hkey.version || device.version,
    build: hkey.build || device.build,
    _time: String(timeSec),
    dw: device.dw,
    channel: device.channel,
    x_app: device.x_app,
    time_zone: device.time_zone
  };
  if (extra) {
    Object.keys(extra).forEach(function (key) {
      params[key] = extra[key];
    });
  }
  return query(params);
}

function appHeaders(account) {
  return {
    "User-Agent": UA_APP,
    Referer: REFERER_APP,
    Accept: "application/json",
    Cookie: account.cookie
  };
}

function signedGet(account, device, path, extra) {
  var timeSec = Math.floor(Date.now() / 1000);
  return fetchHkey(account.heyboxId, device.imei, path, timeSec).then(function (hkey) {
    if (hkey.error) return { error: hkey.error };
    var url = API_BASE + path + "?" + signedQuery(account, device, hkey, timeSec, extra);
    return httpGetJson(url, appHeaders(account)).then(function (payload) {
      if (!payload) return { error: "接口无响应或无有效 JSON" };
      return { payload: payload };
    });
  });
}

// 已签到的判定枚举, 取值来自既有实现; 待用真实 HAR 核对后再收窄
var SIGNED_STATES = ["ok", "finish", "ignore"];

function isAlreadySigned(state) {
  return SIGNED_STATES.indexOf(text(state)) >= 0;
}

function isExpired(payload) {
  var message = text(payload && payload.msg);
  return message.indexOf("重新登录") >= 0 || message.indexOf("登录") >= 0;
}

function summarizeState(result) {
  if (!result) return "";
  var parts = [];
  if (result.sign_in_coin) parts.push("+" + result.sign_in_coin + "H币");
  if (result.sign_in_exp) parts.push("+" + result.sign_in_exp + "经验");
  if (result.sign_in_streak) parts.push("连签" + result.sign_in_streak + "天");
  return parts.join(" ");
}

function readSignState(account, device) {
  return signedGet(account, device, PATH_STATE).then(function (response) {
    if (response.error) return { error: response.error };
    var result = response.payload.result || {};
    return {
      state: text(result.state),
      summary: summarizeState(result),
      expired: isExpired(response.payload)
    };
  });
}

function readTaskList(account, device) {
  return signedGet(account, device, PATH_LIST).then(function (response) {
    if (response.error) return null;
    var result = response.payload.result || {};
    var user = result.user || {};
    var levelInfo = user.level_info || {};
    return {
      nickname: text(user.username),
      coin: text(levelInfo.coin)
    };
  });
}

function signOne(account, device) {
  var out = { id: account.heyboxId, name: account.heyboxId, status: "", detail: "", coin: "" };

  return readSignState(account, device).then(function (pre) {
    if (!pre.error && isAlreadySigned(pre.state)) {
      out.status = "今日已签到";
      out.detail = pre.summary;
      return null;
    }
    if (pre.error) log("账号 " + account.heyboxId + " 状态预查失败, 继续签到: " + pre.error);

    return signedGet(account, device, PATH_SIGN).then(function (response) {
      if (response.error) {
        out.status = "签到失败";
        out.detail = response.error;
        return null;
      }
      var payload = response.payload;
      var state = text((payload.result || {}).state);
      if (state === "ignore") {
        out.status = "今日已签到";
        return null;
      }
      if (isExpired(payload)) {
        out.status = "Cookie 已失效";
        out.detail = "请打开小黑盒 App 重新抓包录入";
        return null;
      }

      return sleep(SIGN_SETTLE_MS).then(function () {
        return confirmSigned(account, device, 0);
      });
    });
  }).then(function (confirmed) {
    if (confirmed) {
      if (confirmed.ok) {
        out.status = "签到成功";
        out.detail = confirmed.summary;
      } else {
        out.status = "已提交, 未确认";
        out.detail = confirmed.detail;
      }
    }
    return readTaskList(account, device);
  }).then(function (info) {
    if (info) {
      if (info.nickname) out.name = info.nickname;
      if (info.coin) out.coin = info.coin;
    }
    return out;
  });
}

function confirmSigned(account, device, attempt) {
  return readSignState(account, device).then(function (state) {
    if (!state.error && isAlreadySigned(state.state)) {
      return { ok: true, summary: state.summary };
    }
    if (attempt >= SIGN_STATE_RETRIES) {
      return { ok: false, detail: state.error || state.state || "状态未更新" };
    }
    return sleep(1500).then(function () {
      return confirmSigned(account, device, attempt + 1);
    });
  });
}

// ---------------------------------------------------------------- 状态与展示

function saveState(results) {
  setStore(
    JSON.stringify({
      version: VERSION,
      lastRun: nowText(),
      date: today(),
      accounts: results
    }),
    KEY_STATE
  );
}

function summaryText(results) {
  return results
    .map(function (item) {
      var line = item.name + ": " + item.status;
      if (item.detail) line += " (" + item.detail + ")";
      if (item.coin) line += " H币=" + item.coin;
      return line;
    })
    .join("\n");
}

function panelPayload() {
  var state = safeParse(getStore(KEY_STATE), null);
  var accounts = parseAccounts(getStore(KEY_ACCOUNTS));
  var style = "info";
  var content = "";

  if (!accounts.length) {
    style = "alert";
    content = "尚未录入账号\n开启 MITM 后打开小黑盒 App 划两下即可自动录入";
  } else if (!state || !state.accounts || !state.accounts.length) {
    content = "账号 " + accounts.length + " 个, 尚未运行\n在 Surge 中长按 heyboxSign 可手动触发";
  } else {
    content = summaryText(state.accounts);
    var failed = state.accounts.filter(function (item) {
      return item.status !== "今日已签到" && item.status !== "签到成功";
    });
    if (failed.length) style = "alert";
    else if (state.accounts.every(function (item) { return item.status === "签到成功"; })) style = "good";
  }

  return {
    title: "小黑盒签到 v" + VERSION + "  " + (state ? state.lastRun : "未运行"),
    content: content,
    style: style
  };
}

// ---------------------------------------------------------------- 抓包

function capture() {
  var url = ($request && $request.url) || "";
  var params = parseQuery(url);
  var cookie = headerValue($request && $request.headers, "cookie");
  var heyboxId = text(params.heybox_id);
  var pkey = cookieItem(cookie, "pkey");
  var tokenId = cookieItem(cookie, "x_xhh_tokenid");

  if (!heyboxId || !pkey || !tokenId) {
    done();
    return;
  }

  var device = {};
  DEVICE_KEYS.forEach(function (key) {
    if (params[key]) device[key] = params[key];
  });

  var changed = false;
  var known = safeParse(getStore(KEY_DEVICE), {});
  var nextDevice = Object.assign({}, known || {}, device);
  if (JSON.stringify(nextDevice) !== JSON.stringify(known || {})) {
    setStore(JSON.stringify(nextDevice), KEY_DEVICE);
    changed = true;
  }

  var account = heyboxId + "#pkey=" + pkey + ";x_xhh_tokenid=" + tokenId;
  var accounts = parseAccounts(getStore(KEY_ACCOUNTS));
  var existed = accounts.some(function (item) {
    return item.split("#")[0] === heyboxId;
  });
  var kept = accounts.filter(function (item) {
    return item.split("#")[0] !== heyboxId;
  });
  if (!existed || accounts.indexOf(account) < 0) {
    setStore([account].concat(kept).join("&"), KEY_ACCOUNTS);
    changed = true;
  }

  if (changed) {
    notify("小黑盒签到 v" + VERSION, "已录入账号 " + heyboxId, "设备参数已同步, 每日将自动签到");
    log("已录入账号 " + mask(account));
  }
  done();
}

// ---------------------------------------------------------------- 入口

function runCron() {
  var accounts = parseAccounts(getStore(KEY_ACCOUNTS));
  if (!accounts.length) {
    notify("小黑盒签到 v" + VERSION, "未找到账号", "开启 MITM 后打开小黑盒 App 完成一次抓包录入");
    log("未找到账号, 退出");
    done();
    return;
  }

  var device = readDevice();
  log("小黑盒签到 v" + VERSION + " 账号数=" + accounts.length + " imei=" + mask(device.imei));

  var results = [];
  var chain = Promise.resolve();
  accounts.forEach(function (item) {
    chain = chain.then(function () {
      return signOne(toAccount(item), device).then(function (result) {
        results.push(result);
        log(result.name + " -> " + result.status + (result.detail ? " (" + result.detail + ")" : ""));
      });
    });
  });

  chain
    .then(function () {
      saveState(results);
      var failed = results.filter(function (item) {
        return item.status !== "今日已签到" && item.status !== "签到成功";
      });
      notify(
        "小黑盒签到 v" + VERSION,
        failed.length ? "有 " + failed.length + " 个账号未完成" : "全部完成 " + results.length + "/" + results.length,
        summaryText(results)
      );
      done();
    })
    .catch(function (error) {
      log("运行异常: " + error.message);
      notify("小黑盒签到 v" + VERSION, "运行异常", error.message);
      done();
    });
}

function main() {
  if (typeof $request !== "undefined") {
    capture();
    return;
  }
  if (typeof $input !== "undefined" && $input && $input.purpose === "panel") {
    done(panelPayload());
    return;
  }
  runCron();
}

main();
