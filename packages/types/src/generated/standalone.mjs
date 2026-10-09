var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// node_modules/.pnpm/ajv@8.17.1/node_modules/ajv/dist/runtime/ucs2length.js
var require_ucs2length = __commonJS({
  "node_modules/.pnpm/ajv@8.17.1/node_modules/ajv/dist/runtime/ucs2length.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    function ucs2length(str) {
      const len = str.length;
      let length = 0;
      let pos = 0;
      let value;
      while (pos < len) {
        length++;
        value = str.charCodeAt(pos++);
        if (value >= 55296 && value <= 56319 && pos < len) {
          value = str.charCodeAt(pos);
          if ((value & 64512) === 56320)
            pos++;
        }
      }
      return length;
    }
    exports.default = ucs2length;
    ucs2length.code = 'require("ajv/dist/runtime/ucs2length").default';
  }
});

// node_modules/.pnpm/ajv-formats@3.0.1_ajv@8.17.1/node_modules/ajv-formats/dist/formats.js
var require_formats = __commonJS({
  "node_modules/.pnpm/ajv-formats@3.0.1_ajv@8.17.1/node_modules/ajv-formats/dist/formats.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.formatNames = exports.fastFormats = exports.fullFormats = void 0;
    function fmtDef(validate, compare) {
      return { validate, compare };
    }
    exports.fullFormats = {
      // date: http://tools.ietf.org/html/rfc3339#section-5.6
      date: fmtDef(date, compareDate),
      // date-time: http://tools.ietf.org/html/rfc3339#section-5.6
      time: fmtDef(getTime(true), compareTime),
      "date-time": fmtDef(getDateTime(true), compareDateTime),
      "iso-time": fmtDef(getTime(), compareIsoTime),
      "iso-date-time": fmtDef(getDateTime(), compareIsoDateTime),
      // duration: https://tools.ietf.org/html/rfc3339#appendix-A
      duration: /^P(?!$)((\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?|(\d+W)?)$/,
      uri,
      "uri-reference": /^(?:[a-z][a-z0-9+\-.]*:)?(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'"()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?(?:\?(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i,
      // uri-template: https://tools.ietf.org/html/rfc6570
      "uri-template": /^(?:(?:[^\x00-\x20"'<>%\\^`{|}]|%[0-9a-f]{2})|\{[+#./;?&=,!@|]?(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?(?:,(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?)*\})*$/i,
      // For the source: https://gist.github.com/dperini/729294
      // For test cases: https://mathiasbynens.be/demo/url-regex
      url: /^(?:https?|ftp):\/\/(?:\S+(?::\S*)?@)?(?:(?!(?:10|127)(?:\.\d{1,3}){3})(?!(?:169\.254|192\.168)(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)(?:\.(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)*(?:\.(?:[a-z\u{00a1}-\u{ffff}]{2,})))(?::\d{2,5})?(?:\/[^\s]*)?$/iu,
      email: /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i,
      hostname: /^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*\.?$/i,
      // optimized https://www.safaribooksonline.com/library/view/regular-expressions-cookbook/9780596802837/ch07s16.html
      ipv4: /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/,
      ipv6: /^((([0-9a-f]{1,4}:){7}([0-9a-f]{1,4}|:))|(([0-9a-f]{1,4}:){6}(:[0-9a-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){5}(((:[0-9a-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){4}(((:[0-9a-f]{1,4}){1,3})|((:[0-9a-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){3}(((:[0-9a-f]{1,4}){1,4})|((:[0-9a-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){2}(((:[0-9a-f]{1,4}){1,5})|((:[0-9a-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){1}(((:[0-9a-f]{1,4}){1,6})|((:[0-9a-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9a-f]{1,4}){1,7})|((:[0-9a-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))$/i,
      regex,
      // uuid: http://tools.ietf.org/html/rfc4122
      uuid: /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i,
      // JSON-pointer: https://tools.ietf.org/html/rfc6901
      // uri fragment: https://tools.ietf.org/html/rfc3986#appendix-A
      "json-pointer": /^(?:\/(?:[^~/]|~0|~1)*)*$/,
      "json-pointer-uri-fragment": /^#(?:\/(?:[a-z0-9_\-.!$&'()*+,;:=@]|%[0-9a-f]{2}|~0|~1)*)*$/i,
      // relative JSON-pointer: http://tools.ietf.org/html/draft-luff-relative-json-pointer-00
      "relative-json-pointer": /^(?:0|[1-9][0-9]*)(?:#|(?:\/(?:[^~/]|~0|~1)*)*)$/,
      // the following formats are used by the openapi specification: https://spec.openapis.org/oas/v3.0.0#data-types
      // byte: https://github.com/miguelmota/is-base64
      byte,
      // signed 32 bit integer
      int32: { type: "number", validate: validateInt32 },
      // signed 64 bit integer
      int64: { type: "number", validate: validateInt64 },
      // C-type float
      float: { type: "number", validate: validateNumber },
      // C-type double
      double: { type: "number", validate: validateNumber },
      // hint to the UI to hide input strings
      password: true,
      // unchecked string payload
      binary: true
    };
    exports.fastFormats = {
      ...exports.fullFormats,
      date: fmtDef(/^\d\d\d\d-[0-1]\d-[0-3]\d$/, compareDate),
      time: fmtDef(/^(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)$/i, compareTime),
      "date-time": fmtDef(/^\d\d\d\d-[0-1]\d-[0-3]\dt(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)$/i, compareDateTime),
      "iso-time": fmtDef(/^(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)?$/i, compareIsoTime),
      "iso-date-time": fmtDef(/^\d\d\d\d-[0-1]\d-[0-3]\d[t\s](?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)?$/i, compareIsoDateTime),
      // uri: https://github.com/mafintosh/is-my-json-valid/blob/master/formats.js
      uri: /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/)?[^\s]*$/i,
      "uri-reference": /^(?:(?:[a-z][a-z0-9+\-.]*:)?\/?\/)?(?:[^\\\s#][^\s#]*)?(?:#[^\\\s]*)?$/i,
      // email (sources from jsen validator):
      // http://stackoverflow.com/questions/201323/using-a-regular-expression-to-validate-an-email-address#answer-8829363
      // http://www.w3.org/TR/html5/forms.html#valid-e-mail-address (search for 'wilful violation')
      email: /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i
    };
    exports.formatNames = Object.keys(exports.fullFormats);
    function isLeapYear(year) {
      return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    }
    var DATE = /^(\d\d\d\d)-(\d\d)-(\d\d)$/;
    var DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    function date(str) {
      const matches = DATE.exec(str);
      if (!matches)
        return false;
      const year = +matches[1];
      const month = +matches[2];
      const day = +matches[3];
      return month >= 1 && month <= 12 && day >= 1 && day <= (month === 2 && isLeapYear(year) ? 29 : DAYS[month]);
    }
    function compareDate(d1, d2) {
      if (!(d1 && d2))
        return void 0;
      if (d1 > d2)
        return 1;
      if (d1 < d2)
        return -1;
      return 0;
    }
    var TIME = /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(z|([+-])(\d\d)(?::?(\d\d))?)?$/i;
    function getTime(strictTimeZone) {
      return function time(str) {
        const matches = TIME.exec(str);
        if (!matches)
          return false;
        const hr = +matches[1];
        const min = +matches[2];
        const sec = +matches[3];
        const tz = matches[4];
        const tzSign = matches[5] === "-" ? -1 : 1;
        const tzH = +(matches[6] || 0);
        const tzM = +(matches[7] || 0);
        if (tzH > 23 || tzM > 59 || strictTimeZone && !tz)
          return false;
        if (hr <= 23 && min <= 59 && sec < 60)
          return true;
        const utcMin = min - tzM * tzSign;
        const utcHr = hr - tzH * tzSign - (utcMin < 0 ? 1 : 0);
        return (utcHr === 23 || utcHr === -1) && (utcMin === 59 || utcMin === -1) && sec < 61;
      };
    }
    function compareTime(s1, s2) {
      if (!(s1 && s2))
        return void 0;
      const t1 = (/* @__PURE__ */ new Date("2020-01-01T" + s1)).valueOf();
      const t2 = (/* @__PURE__ */ new Date("2020-01-01T" + s2)).valueOf();
      if (!(t1 && t2))
        return void 0;
      return t1 - t2;
    }
    function compareIsoTime(t1, t2) {
      if (!(t1 && t2))
        return void 0;
      const a1 = TIME.exec(t1);
      const a2 = TIME.exec(t2);
      if (!(a1 && a2))
        return void 0;
      t1 = a1[1] + a1[2] + a1[3];
      t2 = a2[1] + a2[2] + a2[3];
      if (t1 > t2)
        return 1;
      if (t1 < t2)
        return -1;
      return 0;
    }
    var DATE_TIME_SEPARATOR = /t|\s/i;
    function getDateTime(strictTimeZone) {
      const time = getTime(strictTimeZone);
      return function date_time(str) {
        const dateTime = str.split(DATE_TIME_SEPARATOR);
        return dateTime.length === 2 && date(dateTime[0]) && time(dateTime[1]);
      };
    }
    function compareDateTime(dt1, dt2) {
      if (!(dt1 && dt2))
        return void 0;
      const d1 = new Date(dt1).valueOf();
      const d2 = new Date(dt2).valueOf();
      if (!(d1 && d2))
        return void 0;
      return d1 - d2;
    }
    function compareIsoDateTime(dt1, dt2) {
      if (!(dt1 && dt2))
        return void 0;
      const [d1, t1] = dt1.split(DATE_TIME_SEPARATOR);
      const [d2, t2] = dt2.split(DATE_TIME_SEPARATOR);
      const res = compareDate(d1, d2);
      if (res === void 0)
        return void 0;
      return res || compareTime(t1, t2);
    }
    var NOT_URI_FRAGMENT = /\/|:/;
    var URI = /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)(?:\?(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
    function uri(str) {
      return NOT_URI_FRAGMENT.test(str) && URI.test(str);
    }
    var BYTE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/gm;
    function byte(str) {
      BYTE.lastIndex = 0;
      return BYTE.test(str);
    }
    var MIN_INT32 = -(2 ** 31);
    var MAX_INT32 = 2 ** 31 - 1;
    function validateInt32(value) {
      return Number.isInteger(value) && value <= MAX_INT32 && value >= MIN_INT32;
    }
    function validateInt64(value) {
      return Number.isInteger(value);
    }
    function validateNumber() {
      return true;
    }
    var Z_ANCHOR = /[^\\]\\Z/;
    function regex(str) {
      if (Z_ANCHOR.test(str))
        return false;
      try {
        new RegExp(str);
        return true;
      } catch (e) {
        return false;
      }
    }
  }
});

// standalone.js
var validateAppConfig = validate10;
var schema11 = { "$schema": "http://json-schema.org/draft-07/schema#", "$id": "https://lattice.dev/schemas/app-config.json", "title": "AppConfig", "description": "Public, non-secret configuration served by GET /v1/config. Never add secrets here.", "type": "object", "additionalProperties": false, "required": ["version", "tenant_id", "backend_url", "realtime_url", "app_key", "schema_version", "min_client_version", "features", "collections"], "properties": { "version": { "type": "integer", "const": 1, "description": "Version of this config format." }, "tenant_id": { "type": "string", "minLength": 1 }, "backend_url": { "type": "string", "format": "uri", "pattern": "^https?://[^/\\s?#]+(?:/[^\\s?#]*)?$", "description": "Stable tenant hostname, never an instance address." }, "realtime_url": { "type": "string", "format": "uri", "pattern": "^https?://[^/\\s?#]+(?:/[^\\s?#]*)?$", "description": "PocketBase realtime (SSE) endpoint." }, "app_key": { "type": "string", "minLength": 1, "description": "Publishable key. Not a secret." }, "schema_version": { "type": "string", "minLength": 1 }, "min_client_version": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$", "description": "Oldest client version this backend supports." }, "features": { "type": "array", "uniqueItems": true, "items": { "type": "string", "minLength": 1 } }, "collections": { "type": "array", "uniqueItems": true, "items": { "type": "string", "minLength": 1 } } } };
var func2 = Object.prototype.hasOwnProperty;
var func3 = require_ucs2length().default;
var formats0 = require_formats().fullFormats.uri;
var pattern0 = new RegExp("^https?://[^/\\s?#]+(?:/[^\\s?#]*)?$", "u");
var pattern2 = new RegExp("^\\d+\\.\\d+\\.\\d+$", "u");
function validate10(data, { instancePath = "", parentData, parentDataProperty, rootData = data } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.version === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "version" }, message: "must have required property 'version'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.tenant_id === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "tenant_id" }, message: "must have required property 'tenant_id'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.backend_url === void 0) {
      const err2 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "backend_url" }, message: "must have required property 'backend_url'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.realtime_url === void 0) {
      const err3 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "realtime_url" }, message: "must have required property 'realtime_url'" };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.app_key === void 0) {
      const err4 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "app_key" }, message: "must have required property 'app_key'" };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    if (data.schema_version === void 0) {
      const err5 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "schema_version" }, message: "must have required property 'schema_version'" };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    if (data.min_client_version === void 0) {
      const err6 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "min_client_version" }, message: "must have required property 'min_client_version'" };
      if (vErrors === null) {
        vErrors = [err6];
      } else {
        vErrors.push(err6);
      }
      errors++;
    }
    if (data.features === void 0) {
      const err7 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "features" }, message: "must have required property 'features'" };
      if (vErrors === null) {
        vErrors = [err7];
      } else {
        vErrors.push(err7);
      }
      errors++;
    }
    if (data.collections === void 0) {
      const err8 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "collections" }, message: "must have required property 'collections'" };
      if (vErrors === null) {
        vErrors = [err8];
      } else {
        vErrors.push(err8);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!func2.call(schema11.properties, key0)) {
        const err9 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err9];
        } else {
          vErrors.push(err9);
        }
        errors++;
      }
    }
    if (data.version !== void 0) {
      let data0 = data.version;
      if (!(typeof data0 == "number" && (!(data0 % 1) && !isNaN(data0)) && isFinite(data0))) {
        const err10 = { instancePath: instancePath + "/version", schemaPath: "#/properties/version/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err10];
        } else {
          vErrors.push(err10);
        }
        errors++;
      }
      if (1 !== data0) {
        const err11 = { instancePath: instancePath + "/version", schemaPath: "#/properties/version/const", keyword: "const", params: { allowedValue: 1 }, message: "must be equal to constant" };
        if (vErrors === null) {
          vErrors = [err11];
        } else {
          vErrors.push(err11);
        }
        errors++;
      }
    }
    if (data.tenant_id !== void 0) {
      let data1 = data.tenant_id;
      if (typeof data1 === "string") {
        if (func3(data1) < 1) {
          const err12 = { instancePath: instancePath + "/tenant_id", schemaPath: "#/properties/tenant_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err12];
          } else {
            vErrors.push(err12);
          }
          errors++;
        }
      } else {
        const err13 = { instancePath: instancePath + "/tenant_id", schemaPath: "#/properties/tenant_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err13];
        } else {
          vErrors.push(err13);
        }
        errors++;
      }
    }
    if (data.backend_url !== void 0) {
      let data2 = data.backend_url;
      if (typeof data2 === "string") {
        if (!pattern0.test(data2)) {
          const err14 = { instancePath: instancePath + "/backend_url", schemaPath: "#/properties/backend_url/pattern", keyword: "pattern", params: { pattern: "^https?://[^/\\s?#]+(?:/[^\\s?#]*)?$" }, message: 'must match pattern "^https?://[^/\\s?#]+(?:/[^\\s?#]*)?$"' };
          if (vErrors === null) {
            vErrors = [err14];
          } else {
            vErrors.push(err14);
          }
          errors++;
        }
        if (!formats0(data2)) {
          const err15 = { instancePath: instancePath + "/backend_url", schemaPath: "#/properties/backend_url/format", keyword: "format", params: { format: "uri" }, message: 'must match format "uri"' };
          if (vErrors === null) {
            vErrors = [err15];
          } else {
            vErrors.push(err15);
          }
          errors++;
        }
      } else {
        const err16 = { instancePath: instancePath + "/backend_url", schemaPath: "#/properties/backend_url/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err16];
        } else {
          vErrors.push(err16);
        }
        errors++;
      }
    }
    if (data.realtime_url !== void 0) {
      let data3 = data.realtime_url;
      if (typeof data3 === "string") {
        if (!pattern0.test(data3)) {
          const err17 = { instancePath: instancePath + "/realtime_url", schemaPath: "#/properties/realtime_url/pattern", keyword: "pattern", params: { pattern: "^https?://[^/\\s?#]+(?:/[^\\s?#]*)?$" }, message: 'must match pattern "^https?://[^/\\s?#]+(?:/[^\\s?#]*)?$"' };
          if (vErrors === null) {
            vErrors = [err17];
          } else {
            vErrors.push(err17);
          }
          errors++;
        }
        if (!formats0(data3)) {
          const err18 = { instancePath: instancePath + "/realtime_url", schemaPath: "#/properties/realtime_url/format", keyword: "format", params: { format: "uri" }, message: 'must match format "uri"' };
          if (vErrors === null) {
            vErrors = [err18];
          } else {
            vErrors.push(err18);
          }
          errors++;
        }
      } else {
        const err19 = { instancePath: instancePath + "/realtime_url", schemaPath: "#/properties/realtime_url/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err19];
        } else {
          vErrors.push(err19);
        }
        errors++;
      }
    }
    if (data.app_key !== void 0) {
      let data4 = data.app_key;
      if (typeof data4 === "string") {
        if (func3(data4) < 1) {
          const err20 = { instancePath: instancePath + "/app_key", schemaPath: "#/properties/app_key/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err20];
          } else {
            vErrors.push(err20);
          }
          errors++;
        }
      } else {
        const err21 = { instancePath: instancePath + "/app_key", schemaPath: "#/properties/app_key/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err21];
        } else {
          vErrors.push(err21);
        }
        errors++;
      }
    }
    if (data.schema_version !== void 0) {
      let data5 = data.schema_version;
      if (typeof data5 === "string") {
        if (func3(data5) < 1) {
          const err22 = { instancePath: instancePath + "/schema_version", schemaPath: "#/properties/schema_version/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err22];
          } else {
            vErrors.push(err22);
          }
          errors++;
        }
      } else {
        const err23 = { instancePath: instancePath + "/schema_version", schemaPath: "#/properties/schema_version/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err23];
        } else {
          vErrors.push(err23);
        }
        errors++;
      }
    }
    if (data.min_client_version !== void 0) {
      let data6 = data.min_client_version;
      if (typeof data6 === "string") {
        if (!pattern2.test(data6)) {
          const err24 = { instancePath: instancePath + "/min_client_version", schemaPath: "#/properties/min_client_version/pattern", keyword: "pattern", params: { pattern: "^\\d+\\.\\d+\\.\\d+$" }, message: 'must match pattern "^\\d+\\.\\d+\\.\\d+$"' };
          if (vErrors === null) {
            vErrors = [err24];
          } else {
            vErrors.push(err24);
          }
          errors++;
        }
      } else {
        const err25 = { instancePath: instancePath + "/min_client_version", schemaPath: "#/properties/min_client_version/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err25];
        } else {
          vErrors.push(err25);
        }
        errors++;
      }
    }
    if (data.features !== void 0) {
      let data7 = data.features;
      if (Array.isArray(data7)) {
        const len0 = data7.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data8 = data7[i0];
          if (typeof data8 === "string") {
            if (func3(data8) < 1) {
              const err26 = { instancePath: instancePath + "/features/" + i0, schemaPath: "#/properties/features/items/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
              if (vErrors === null) {
                vErrors = [err26];
              } else {
                vErrors.push(err26);
              }
              errors++;
            }
          } else {
            const err27 = { instancePath: instancePath + "/features/" + i0, schemaPath: "#/properties/features/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err27];
            } else {
              vErrors.push(err27);
            }
            errors++;
          }
        }
        let i1 = data7.length;
        let j0;
        if (i1 > 1) {
          const indices0 = {};
          for (; i1--; ) {
            let item0 = data7[i1];
            if (typeof item0 !== "string") {
              continue;
            }
            if (typeof indices0[item0] == "number") {
              j0 = indices0[item0];
              const err28 = { instancePath: instancePath + "/features", schemaPath: "#/properties/features/uniqueItems", keyword: "uniqueItems", params: { i: i1, j: j0 }, message: "must NOT have duplicate items (items ## " + j0 + " and " + i1 + " are identical)" };
              if (vErrors === null) {
                vErrors = [err28];
              } else {
                vErrors.push(err28);
              }
              errors++;
              break;
            }
            indices0[item0] = i1;
          }
        }
      } else {
        const err29 = { instancePath: instancePath + "/features", schemaPath: "#/properties/features/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err29];
        } else {
          vErrors.push(err29);
        }
        errors++;
      }
    }
    if (data.collections !== void 0) {
      let data9 = data.collections;
      if (Array.isArray(data9)) {
        const len1 = data9.length;
        for (let i2 = 0; i2 < len1; i2++) {
          let data10 = data9[i2];
          if (typeof data10 === "string") {
            if (func3(data10) < 1) {
              const err30 = { instancePath: instancePath + "/collections/" + i2, schemaPath: "#/properties/collections/items/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
              if (vErrors === null) {
                vErrors = [err30];
              } else {
                vErrors.push(err30);
              }
              errors++;
            }
          } else {
            const err31 = { instancePath: instancePath + "/collections/" + i2, schemaPath: "#/properties/collections/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err31];
            } else {
              vErrors.push(err31);
            }
            errors++;
          }
        }
        let i3 = data9.length;
        let j1;
        if (i3 > 1) {
          const indices1 = {};
          for (; i3--; ) {
            let item1 = data9[i3];
            if (typeof item1 !== "string") {
              continue;
            }
            if (typeof indices1[item1] == "number") {
              j1 = indices1[item1];
              const err32 = { instancePath: instancePath + "/collections", schemaPath: "#/properties/collections/uniqueItems", keyword: "uniqueItems", params: { i: i3, j: j1 }, message: "must NOT have duplicate items (items ## " + j1 + " and " + i3 + " are identical)" };
              if (vErrors === null) {
                vErrors = [err32];
              } else {
                vErrors.push(err32);
              }
              errors++;
              break;
            }
            indices1[item1] = i3;
          }
        }
      } else {
        const err33 = { instancePath: instancePath + "/collections", schemaPath: "#/properties/collections/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err33];
        } else {
          vErrors.push(err33);
        }
        errors++;
      }
    }
  } else {
    const err34 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err34];
    } else {
      vErrors.push(err34);
    }
    errors++;
  }
  validate10.errors = vErrors;
  return errors === 0;
}
var validateFeatures = validate11;
var pattern3 = new RegExp("^[a-z][a-z0-9_-]{0,48}$", "u");
function validate11(data, { instancePath = "", parentData, parentDataProperty, rootData = data } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.features === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "features" }, message: "must have required property 'features'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "features")) {
        const err1 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
    }
    if (data.features !== void 0) {
      let data0 = data.features;
      if (data0 && typeof data0 == "object" && !Array.isArray(data0)) {
        for (const key1 in data0) {
          const _errs4 = errors;
          if (typeof key1 === "string") {
            if (!pattern3.test(key1)) {
              const err2 = { instancePath: instancePath + "/features", schemaPath: "#/properties/features/propertyNames/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9_-]{0,48}$" }, message: 'must match pattern "^[a-z][a-z0-9_-]{0,48}$"', propertyName: key1 };
              if (vErrors === null) {
                vErrors = [err2];
              } else {
                vErrors.push(err2);
              }
              errors++;
            }
          }
          var valid1 = _errs4 === errors;
          if (!valid1) {
            const err3 = { instancePath: instancePath + "/features", schemaPath: "#/properties/features/propertyNames", keyword: "propertyNames", params: { propertyName: key1 }, message: "property name must be valid" };
            if (vErrors === null) {
              vErrors = [err3];
            } else {
              vErrors.push(err3);
            }
            errors++;
          }
        }
        for (const key2 in data0) {
          let data1 = data0[key2];
          if (data1 && typeof data1 == "object" && !Array.isArray(data1)) {
            if (data1.enabled === void 0) {
              const err4 = { instancePath: instancePath + "/features/" + key2.replace(/~/g, "~0").replace(/\//g, "~1"), schemaPath: "#/$defs/Feature/required", keyword: "required", params: { missingProperty: "enabled" }, message: "must have required property 'enabled'" };
              if (vErrors === null) {
                vErrors = [err4];
              } else {
                vErrors.push(err4);
              }
              errors++;
            }
            for (const key3 in data1) {
              if (!(key3 === "enabled" || key3 === "options")) {
                const err5 = { instancePath: instancePath + "/features/" + key2.replace(/~/g, "~0").replace(/\//g, "~1"), schemaPath: "#/$defs/Feature/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key3 }, message: "must NOT have additional properties" };
                if (vErrors === null) {
                  vErrors = [err5];
                } else {
                  vErrors.push(err5);
                }
                errors++;
              }
            }
            if (data1.enabled !== void 0) {
              if (typeof data1.enabled !== "boolean") {
                const err6 = { instancePath: instancePath + "/features/" + key2.replace(/~/g, "~0").replace(/\//g, "~1") + "/enabled", schemaPath: "#/$defs/Feature/properties/enabled/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" };
                if (vErrors === null) {
                  vErrors = [err6];
                } else {
                  vErrors.push(err6);
                }
                errors++;
              }
            }
            if (data1.options !== void 0) {
              let data3 = data1.options;
              if (data3 && typeof data3 == "object" && !Array.isArray(data3)) {
              } else {
                const err7 = { instancePath: instancePath + "/features/" + key2.replace(/~/g, "~0").replace(/\//g, "~1") + "/options", schemaPath: "#/$defs/Feature/properties/options/type", keyword: "type", params: { type: "object" }, message: "must be object" };
                if (vErrors === null) {
                  vErrors = [err7];
                } else {
                  vErrors.push(err7);
                }
                errors++;
              }
            }
          } else {
            const err8 = { instancePath: instancePath + "/features/" + key2.replace(/~/g, "~0").replace(/\//g, "~1"), schemaPath: "#/$defs/Feature/type", keyword: "type", params: { type: "object" }, message: "must be object" };
            if (vErrors === null) {
              vErrors = [err8];
            } else {
              vErrors.push(err8);
            }
            errors++;
          }
        }
      } else {
        const err9 = { instancePath: instancePath + "/features", schemaPath: "#/properties/features/type", keyword: "type", params: { type: "object" }, message: "must be object" };
        if (vErrors === null) {
          vErrors = [err9];
        } else {
          vErrors.push(err9);
        }
        errors++;
      }
    }
  } else {
    const err10 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err10];
    } else {
      vErrors.push(err10);
    }
    errors++;
  }
  validate11.errors = vErrors;
  return errors === 0;
}
var validateDashboardLayout = validate12;
var schema15 = { "type": "object", "additionalProperties": false, "required": ["id", "type", "collection", "x", "y", "w", "h"], "properties": { "id": { "type": "string", "minLength": 1 }, "type": { "enum": ["table", "chart", "kpi", "form", "list"] }, "collection": { "type": "string", "pattern": "^[a-zA-Z_][a-zA-Z0-9_]*$" }, "x": { "type": "integer", "minimum": 0 }, "y": { "type": "integer", "minimum": 0 }, "w": { "type": "integer", "minimum": 1, "maximum": 12 }, "h": { "type": "integer", "minimum": 1 }, "props": { "$ref": "#/$defs/WidgetProps" } } };
var schema16 = { "type": "object", "additionalProperties": false, "properties": { "filter": { "type": "string", "maxLength": 500, "description": "PocketBase filter with {:name} placeholders bound from params." }, "params": { "type": "object", "additionalProperties": { "type": ["string", "number", "boolean"] } }, "sort": { "type": "string", "pattern": "^-?[a-zA-Z_][a-zA-Z0-9_.]*(,-?[a-zA-Z_][a-zA-Z0-9_.]*)*$" }, "metric": { "type": "string", "pattern": "^(count|(sum|avg|min|max):[a-zA-Z_][a-zA-Z0-9_]*)$" }, "groupBy": { "type": "string", "pattern": "^[a-zA-Z_][a-zA-Z0-9_]*(:(day|week|month|year))?$" }, "fields": { "type": "array", "maxItems": 50, "items": { "type": "string", "pattern": "^[a-zA-Z_][a-zA-Z0-9_.]*$" } } } };
var pattern4 = new RegExp("^[a-zA-Z_][a-zA-Z0-9_]*$", "u");
var pattern5 = new RegExp("^-?[a-zA-Z_][a-zA-Z0-9_.]*(,-?[a-zA-Z_][a-zA-Z0-9_.]*)*$", "u");
var pattern6 = new RegExp("^(count|(sum|avg|min|max):[a-zA-Z_][a-zA-Z0-9_]*)$", "u");
var pattern7 = new RegExp("^[a-zA-Z_][a-zA-Z0-9_]*(:(day|week|month|year))?$", "u");
var pattern8 = new RegExp("^[a-zA-Z_][a-zA-Z0-9_.]*$", "u");
function validate13(data, { instancePath = "", parentData, parentDataProperty, rootData = data } = {}) {
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.id === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "id" }, message: "must have required property 'id'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.type === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "type" }, message: "must have required property 'type'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.collection === void 0) {
      const err2 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "collection" }, message: "must have required property 'collection'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.x === void 0) {
      const err3 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "x" }, message: "must have required property 'x'" };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.y === void 0) {
      const err4 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "y" }, message: "must have required property 'y'" };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    if (data.w === void 0) {
      const err5 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "w" }, message: "must have required property 'w'" };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    if (data.h === void 0) {
      const err6 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "h" }, message: "must have required property 'h'" };
      if (vErrors === null) {
        vErrors = [err6];
      } else {
        vErrors.push(err6);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "id" || key0 === "type" || key0 === "collection" || key0 === "x" || key0 === "y" || key0 === "w" || key0 === "h" || key0 === "props")) {
        const err7 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err7];
        } else {
          vErrors.push(err7);
        }
        errors++;
      }
    }
    if (data.id !== void 0) {
      let data0 = data.id;
      if (typeof data0 === "string") {
        if (func3(data0) < 1) {
          const err8 = { instancePath: instancePath + "/id", schemaPath: "#/properties/id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err8];
          } else {
            vErrors.push(err8);
          }
          errors++;
        }
      } else {
        const err9 = { instancePath: instancePath + "/id", schemaPath: "#/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err9];
        } else {
          vErrors.push(err9);
        }
        errors++;
      }
    }
    if (data.type !== void 0) {
      let data1 = data.type;
      if (!(data1 === "table" || data1 === "chart" || data1 === "kpi" || data1 === "form" || data1 === "list")) {
        const err10 = { instancePath: instancePath + "/type", schemaPath: "#/properties/type/enum", keyword: "enum", params: { allowedValues: schema15.properties.type.enum }, message: "must be equal to one of the allowed values" };
        if (vErrors === null) {
          vErrors = [err10];
        } else {
          vErrors.push(err10);
        }
        errors++;
      }
    }
    if (data.collection !== void 0) {
      let data2 = data.collection;
      if (typeof data2 === "string") {
        if (!pattern4.test(data2)) {
          const err11 = { instancePath: instancePath + "/collection", schemaPath: "#/properties/collection/pattern", keyword: "pattern", params: { pattern: "^[a-zA-Z_][a-zA-Z0-9_]*$" }, message: 'must match pattern "^[a-zA-Z_][a-zA-Z0-9_]*$"' };
          if (vErrors === null) {
            vErrors = [err11];
          } else {
            vErrors.push(err11);
          }
          errors++;
        }
      } else {
        const err12 = { instancePath: instancePath + "/collection", schemaPath: "#/properties/collection/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err12];
        } else {
          vErrors.push(err12);
        }
        errors++;
      }
    }
    if (data.x !== void 0) {
      let data3 = data.x;
      if (!(typeof data3 == "number" && (!(data3 % 1) && !isNaN(data3)) && isFinite(data3))) {
        const err13 = { instancePath: instancePath + "/x", schemaPath: "#/properties/x/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err13];
        } else {
          vErrors.push(err13);
        }
        errors++;
      }
      if (typeof data3 == "number" && isFinite(data3)) {
        if (data3 < 0 || isNaN(data3)) {
          const err14 = { instancePath: instancePath + "/x", schemaPath: "#/properties/x/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" };
          if (vErrors === null) {
            vErrors = [err14];
          } else {
            vErrors.push(err14);
          }
          errors++;
        }
      }
    }
    if (data.y !== void 0) {
      let data4 = data.y;
      if (!(typeof data4 == "number" && (!(data4 % 1) && !isNaN(data4)) && isFinite(data4))) {
        const err15 = { instancePath: instancePath + "/y", schemaPath: "#/properties/y/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err15];
        } else {
          vErrors.push(err15);
        }
        errors++;
      }
      if (typeof data4 == "number" && isFinite(data4)) {
        if (data4 < 0 || isNaN(data4)) {
          const err16 = { instancePath: instancePath + "/y", schemaPath: "#/properties/y/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" };
          if (vErrors === null) {
            vErrors = [err16];
          } else {
            vErrors.push(err16);
          }
          errors++;
        }
      }
    }
    if (data.w !== void 0) {
      let data5 = data.w;
      if (!(typeof data5 == "number" && (!(data5 % 1) && !isNaN(data5)) && isFinite(data5))) {
        const err17 = { instancePath: instancePath + "/w", schemaPath: "#/properties/w/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err17];
        } else {
          vErrors.push(err17);
        }
        errors++;
      }
      if (typeof data5 == "number" && isFinite(data5)) {
        if (data5 > 12 || isNaN(data5)) {
          const err18 = { instancePath: instancePath + "/w", schemaPath: "#/properties/w/maximum", keyword: "maximum", params: { comparison: "<=", limit: 12 }, message: "must be <= 12" };
          if (vErrors === null) {
            vErrors = [err18];
          } else {
            vErrors.push(err18);
          }
          errors++;
        }
        if (data5 < 1 || isNaN(data5)) {
          const err19 = { instancePath: instancePath + "/w", schemaPath: "#/properties/w/minimum", keyword: "minimum", params: { comparison: ">=", limit: 1 }, message: "must be >= 1" };
          if (vErrors === null) {
            vErrors = [err19];
          } else {
            vErrors.push(err19);
          }
          errors++;
        }
      }
    }
    if (data.h !== void 0) {
      let data6 = data.h;
      if (!(typeof data6 == "number" && (!(data6 % 1) && !isNaN(data6)) && isFinite(data6))) {
        const err20 = { instancePath: instancePath + "/h", schemaPath: "#/properties/h/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err20];
        } else {
          vErrors.push(err20);
        }
        errors++;
      }
      if (typeof data6 == "number" && isFinite(data6)) {
        if (data6 < 1 || isNaN(data6)) {
          const err21 = { instancePath: instancePath + "/h", schemaPath: "#/properties/h/minimum", keyword: "minimum", params: { comparison: ">=", limit: 1 }, message: "must be >= 1" };
          if (vErrors === null) {
            vErrors = [err21];
          } else {
            vErrors.push(err21);
          }
          errors++;
        }
      }
    }
    if (data.props !== void 0) {
      let data7 = data.props;
      if (data7 && typeof data7 == "object" && !Array.isArray(data7)) {
        for (const key1 in data7) {
          if (!(key1 === "filter" || key1 === "params" || key1 === "sort" || key1 === "metric" || key1 === "groupBy" || key1 === "fields")) {
            const err22 = { instancePath: instancePath + "/props", schemaPath: "#/$defs/WidgetProps/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key1 }, message: "must NOT have additional properties" };
            if (vErrors === null) {
              vErrors = [err22];
            } else {
              vErrors.push(err22);
            }
            errors++;
          }
        }
        if (data7.filter !== void 0) {
          let data8 = data7.filter;
          if (typeof data8 === "string") {
            if (func3(data8) > 500) {
              const err23 = { instancePath: instancePath + "/props/filter", schemaPath: "#/$defs/WidgetProps/properties/filter/maxLength", keyword: "maxLength", params: { limit: 500 }, message: "must NOT have more than 500 characters" };
              if (vErrors === null) {
                vErrors = [err23];
              } else {
                vErrors.push(err23);
              }
              errors++;
            }
          } else {
            const err24 = { instancePath: instancePath + "/props/filter", schemaPath: "#/$defs/WidgetProps/properties/filter/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err24];
            } else {
              vErrors.push(err24);
            }
            errors++;
          }
        }
        if (data7.params !== void 0) {
          let data9 = data7.params;
          if (data9 && typeof data9 == "object" && !Array.isArray(data9)) {
            for (const key2 in data9) {
              let data10 = data9[key2];
              if (typeof data10 !== "string" && !(typeof data10 == "number" && isFinite(data10)) && typeof data10 !== "boolean") {
                const err25 = { instancePath: instancePath + "/props/params/" + key2.replace(/~/g, "~0").replace(/\//g, "~1"), schemaPath: "#/$defs/WidgetProps/properties/params/additionalProperties/type", keyword: "type", params: { type: schema16.properties.params.additionalProperties.type }, message: "must be string,number,boolean" };
                if (vErrors === null) {
                  vErrors = [err25];
                } else {
                  vErrors.push(err25);
                }
                errors++;
              }
            }
          } else {
            const err26 = { instancePath: instancePath + "/props/params", schemaPath: "#/$defs/WidgetProps/properties/params/type", keyword: "type", params: { type: "object" }, message: "must be object" };
            if (vErrors === null) {
              vErrors = [err26];
            } else {
              vErrors.push(err26);
            }
            errors++;
          }
        }
        if (data7.sort !== void 0) {
          let data11 = data7.sort;
          if (typeof data11 === "string") {
            if (!pattern5.test(data11)) {
              const err27 = { instancePath: instancePath + "/props/sort", schemaPath: "#/$defs/WidgetProps/properties/sort/pattern", keyword: "pattern", params: { pattern: "^-?[a-zA-Z_][a-zA-Z0-9_.]*(,-?[a-zA-Z_][a-zA-Z0-9_.]*)*$" }, message: 'must match pattern "^-?[a-zA-Z_][a-zA-Z0-9_.]*(,-?[a-zA-Z_][a-zA-Z0-9_.]*)*$"' };
              if (vErrors === null) {
                vErrors = [err27];
              } else {
                vErrors.push(err27);
              }
              errors++;
            }
          } else {
            const err28 = { instancePath: instancePath + "/props/sort", schemaPath: "#/$defs/WidgetProps/properties/sort/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err28];
            } else {
              vErrors.push(err28);
            }
            errors++;
          }
        }
        if (data7.metric !== void 0) {
          let data12 = data7.metric;
          if (typeof data12 === "string") {
            if (!pattern6.test(data12)) {
              const err29 = { instancePath: instancePath + "/props/metric", schemaPath: "#/$defs/WidgetProps/properties/metric/pattern", keyword: "pattern", params: { pattern: "^(count|(sum|avg|min|max):[a-zA-Z_][a-zA-Z0-9_]*)$" }, message: 'must match pattern "^(count|(sum|avg|min|max):[a-zA-Z_][a-zA-Z0-9_]*)$"' };
              if (vErrors === null) {
                vErrors = [err29];
              } else {
                vErrors.push(err29);
              }
              errors++;
            }
          } else {
            const err30 = { instancePath: instancePath + "/props/metric", schemaPath: "#/$defs/WidgetProps/properties/metric/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err30];
            } else {
              vErrors.push(err30);
            }
            errors++;
          }
        }
        if (data7.groupBy !== void 0) {
          let data13 = data7.groupBy;
          if (typeof data13 === "string") {
            if (!pattern7.test(data13)) {
              const err31 = { instancePath: instancePath + "/props/groupBy", schemaPath: "#/$defs/WidgetProps/properties/groupBy/pattern", keyword: "pattern", params: { pattern: "^[a-zA-Z_][a-zA-Z0-9_]*(:(day|week|month|year))?$" }, message: 'must match pattern "^[a-zA-Z_][a-zA-Z0-9_]*(:(day|week|month|year))?$"' };
              if (vErrors === null) {
                vErrors = [err31];
              } else {
                vErrors.push(err31);
              }
              errors++;
            }
          } else {
            const err32 = { instancePath: instancePath + "/props/groupBy", schemaPath: "#/$defs/WidgetProps/properties/groupBy/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err32];
            } else {
              vErrors.push(err32);
            }
            errors++;
          }
        }
        if (data7.fields !== void 0) {
          let data14 = data7.fields;
          if (Array.isArray(data14)) {
            if (data14.length > 50) {
              const err33 = { instancePath: instancePath + "/props/fields", schemaPath: "#/$defs/WidgetProps/properties/fields/maxItems", keyword: "maxItems", params: { limit: 50 }, message: "must NOT have more than 50 items" };
              if (vErrors === null) {
                vErrors = [err33];
              } else {
                vErrors.push(err33);
              }
              errors++;
            }
            const len0 = data14.length;
            for (let i0 = 0; i0 < len0; i0++) {
              let data15 = data14[i0];
              if (typeof data15 === "string") {
                if (!pattern8.test(data15)) {
                  const err34 = { instancePath: instancePath + "/props/fields/" + i0, schemaPath: "#/$defs/WidgetProps/properties/fields/items/pattern", keyword: "pattern", params: { pattern: "^[a-zA-Z_][a-zA-Z0-9_.]*$" }, message: 'must match pattern "^[a-zA-Z_][a-zA-Z0-9_.]*$"' };
                  if (vErrors === null) {
                    vErrors = [err34];
                  } else {
                    vErrors.push(err34);
                  }
                  errors++;
                }
              } else {
                const err35 = { instancePath: instancePath + "/props/fields/" + i0, schemaPath: "#/$defs/WidgetProps/properties/fields/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err35];
                } else {
                  vErrors.push(err35);
                }
                errors++;
              }
            }
          } else {
            const err36 = { instancePath: instancePath + "/props/fields", schemaPath: "#/$defs/WidgetProps/properties/fields/type", keyword: "type", params: { type: "array" }, message: "must be array" };
            if (vErrors === null) {
              vErrors = [err36];
            } else {
              vErrors.push(err36);
            }
            errors++;
          }
        }
      } else {
        const err37 = { instancePath: instancePath + "/props", schemaPath: "#/$defs/WidgetProps/type", keyword: "type", params: { type: "object" }, message: "must be object" };
        if (vErrors === null) {
          vErrors = [err37];
        } else {
          vErrors.push(err37);
        }
        errors++;
      }
    }
  } else {
    const err38 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err38];
    } else {
      vErrors.push(err38);
    }
    errors++;
  }
  validate13.errors = vErrors;
  return errors === 0;
}
function validate12(data, { instancePath = "", parentData, parentDataProperty, rootData = data } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.id === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "id" }, message: "must have required property 'id'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.name === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "name" }, message: "must have required property 'name'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.layout === void 0) {
      const err2 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "layout" }, message: "must have required property 'layout'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "id" || key0 === "name" || key0 === "layout")) {
        const err3 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
    }
    if (data.id !== void 0) {
      let data0 = data.id;
      if (typeof data0 === "string") {
        if (func3(data0) < 1) {
          const err4 = { instancePath: instancePath + "/id", schemaPath: "#/properties/id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err4];
          } else {
            vErrors.push(err4);
          }
          errors++;
        }
      } else {
        const err5 = { instancePath: instancePath + "/id", schemaPath: "#/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err5];
        } else {
          vErrors.push(err5);
        }
        errors++;
      }
    }
    if (data.name !== void 0) {
      let data1 = data.name;
      if (typeof data1 === "string") {
        if (func3(data1) < 1) {
          const err6 = { instancePath: instancePath + "/name", schemaPath: "#/properties/name/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err6];
          } else {
            vErrors.push(err6);
          }
          errors++;
        }
      } else {
        const err7 = { instancePath: instancePath + "/name", schemaPath: "#/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err7];
        } else {
          vErrors.push(err7);
        }
        errors++;
      }
    }
    if (data.layout !== void 0) {
      let data2 = data.layout;
      if (Array.isArray(data2)) {
        if (data2.length > 100) {
          const err8 = { instancePath: instancePath + "/layout", schemaPath: "#/properties/layout/maxItems", keyword: "maxItems", params: { limit: 100 }, message: "must NOT have more than 100 items" };
          if (vErrors === null) {
            vErrors = [err8];
          } else {
            vErrors.push(err8);
          }
          errors++;
        }
        const len0 = data2.length;
        for (let i0 = 0; i0 < len0; i0++) {
          if (!validate13(data2[i0], { instancePath: instancePath + "/layout/" + i0, parentData: data2, parentDataProperty: i0, rootData })) {
            vErrors = vErrors === null ? validate13.errors : vErrors.concat(validate13.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err9 = { instancePath: instancePath + "/layout", schemaPath: "#/properties/layout/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err9];
        } else {
          vErrors.push(err9);
        }
        errors++;
      }
    }
  } else {
    const err10 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err10];
    } else {
      vErrors.push(err10);
    }
    errors++;
  }
  validate12.errors = vErrors;
  return errors === 0;
}
var validatePluginManifest = validate15;
var pattern9 = new RegExp("^[a-z][a-z0-9-]{1,48}$", "u");
var pattern11 = new RegExp("^[a-z_]+:[a-z0-9_*]+$", "u");
function validate15(data, { instancePath = "", parentData, parentDataProperty, rootData = data } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.name === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "name" }, message: "must have required property 'name'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.version === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "version" }, message: "must have required property 'version'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.interface_version === void 0) {
      const err2 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "interface_version" }, message: "must have required property 'interface_version'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.license === void 0) {
      const err3 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "license" }, message: "must have required property 'license'" };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "name" || key0 === "version" || key0 === "interface_version" || key0 === "license" || key0 === "requires" || key0 === "permissions")) {
        const err4 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
    if (data.name !== void 0) {
      let data0 = data.name;
      if (typeof data0 === "string") {
        if (!pattern9.test(data0)) {
          const err5 = { instancePath: instancePath + "/name", schemaPath: "#/properties/name/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]{1,48}$" }, message: 'must match pattern "^[a-z][a-z0-9-]{1,48}$"' };
          if (vErrors === null) {
            vErrors = [err5];
          } else {
            vErrors.push(err5);
          }
          errors++;
        }
      } else {
        const err6 = { instancePath: instancePath + "/name", schemaPath: "#/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
    if (data.version !== void 0) {
      let data1 = data.version;
      if (typeof data1 === "string") {
        if (!pattern2.test(data1)) {
          const err7 = { instancePath: instancePath + "/version", schemaPath: "#/properties/version/pattern", keyword: "pattern", params: { pattern: "^\\d+\\.\\d+\\.\\d+$" }, message: 'must match pattern "^\\d+\\.\\d+\\.\\d+$"' };
          if (vErrors === null) {
            vErrors = [err7];
          } else {
            vErrors.push(err7);
          }
          errors++;
        }
      } else {
        const err8 = { instancePath: instancePath + "/version", schemaPath: "#/properties/version/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
    }
    if (data.interface_version !== void 0) {
      let data2 = data.interface_version;
      if (!(typeof data2 == "number" && (!(data2 % 1) && !isNaN(data2)) && isFinite(data2))) {
        const err9 = { instancePath: instancePath + "/interface_version", schemaPath: "#/properties/interface_version/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err9];
        } else {
          vErrors.push(err9);
        }
        errors++;
      }
      if (typeof data2 == "number" && isFinite(data2)) {
        if (data2 < 1 || isNaN(data2)) {
          const err10 = { instancePath: instancePath + "/interface_version", schemaPath: "#/properties/interface_version/minimum", keyword: "minimum", params: { comparison: ">=", limit: 1 }, message: "must be >= 1" };
          if (vErrors === null) {
            vErrors = [err10];
          } else {
            vErrors.push(err10);
          }
          errors++;
        }
      }
    }
    if (data.license !== void 0) {
      let data3 = data.license;
      if (typeof data3 === "string") {
        if (func3(data3) < 1) {
          const err11 = { instancePath: instancePath + "/license", schemaPath: "#/properties/license/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err11];
          } else {
            vErrors.push(err11);
          }
          errors++;
        }
      } else {
        const err12 = { instancePath: instancePath + "/license", schemaPath: "#/properties/license/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err12];
        } else {
          vErrors.push(err12);
        }
        errors++;
      }
    }
    if (data.requires !== void 0) {
      let data4 = data.requires;
      if (Array.isArray(data4)) {
        const len0 = data4.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data5 = data4[i0];
          if (typeof data5 === "string") {
            if (func3(data5) < 1) {
              const err13 = { instancePath: instancePath + "/requires/" + i0, schemaPath: "#/properties/requires/items/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
              if (vErrors === null) {
                vErrors = [err13];
              } else {
                vErrors.push(err13);
              }
              errors++;
            }
          } else {
            const err14 = { instancePath: instancePath + "/requires/" + i0, schemaPath: "#/properties/requires/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err14];
            } else {
              vErrors.push(err14);
            }
            errors++;
          }
        }
        let i1 = data4.length;
        let j0;
        if (i1 > 1) {
          const indices0 = {};
          for (; i1--; ) {
            let item0 = data4[i1];
            if (typeof item0 !== "string") {
              continue;
            }
            if (typeof indices0[item0] == "number") {
              j0 = indices0[item0];
              const err15 = { instancePath: instancePath + "/requires", schemaPath: "#/properties/requires/uniqueItems", keyword: "uniqueItems", params: { i: i1, j: j0 }, message: "must NOT have duplicate items (items ## " + j0 + " and " + i1 + " are identical)" };
              if (vErrors === null) {
                vErrors = [err15];
              } else {
                vErrors.push(err15);
              }
              errors++;
              break;
            }
            indices0[item0] = i1;
          }
        }
      } else {
        const err16 = { instancePath: instancePath + "/requires", schemaPath: "#/properties/requires/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err16];
        } else {
          vErrors.push(err16);
        }
        errors++;
      }
    }
    if (data.permissions !== void 0) {
      let data6 = data.permissions;
      if (Array.isArray(data6)) {
        const len1 = data6.length;
        for (let i2 = 0; i2 < len1; i2++) {
          let data7 = data6[i2];
          if (typeof data7 === "string") {
            if (!pattern11.test(data7)) {
              const err17 = { instancePath: instancePath + "/permissions/" + i2, schemaPath: "#/properties/permissions/items/pattern", keyword: "pattern", params: { pattern: "^[a-z_]+:[a-z0-9_*]+$" }, message: 'must match pattern "^[a-z_]+:[a-z0-9_*]+$"' };
              if (vErrors === null) {
                vErrors = [err17];
              } else {
                vErrors.push(err17);
              }
              errors++;
            }
          } else {
            const err18 = { instancePath: instancePath + "/permissions/" + i2, schemaPath: "#/properties/permissions/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err18];
            } else {
              vErrors.push(err18);
            }
            errors++;
          }
        }
        let i3 = data6.length;
        let j1;
        if (i3 > 1) {
          const indices1 = {};
          for (; i3--; ) {
            let item1 = data6[i3];
            if (typeof item1 !== "string") {
              continue;
            }
            if (typeof indices1[item1] == "number") {
              j1 = indices1[item1];
              const err19 = { instancePath: instancePath + "/permissions", schemaPath: "#/properties/permissions/uniqueItems", keyword: "uniqueItems", params: { i: i3, j: j1 }, message: "must NOT have duplicate items (items ## " + j1 + " and " + i3 + " are identical)" };
              if (vErrors === null) {
                vErrors = [err19];
              } else {
                vErrors.push(err19);
              }
              errors++;
              break;
            }
            indices1[item1] = i3;
          }
        }
      } else {
        const err20 = { instancePath: instancePath + "/permissions", schemaPath: "#/properties/permissions/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err20];
        } else {
          vErrors.push(err20);
        }
        errors++;
      }
    }
  } else {
    const err21 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err21];
    } else {
      vErrors.push(err21);
    }
    errors++;
  }
  validate15.errors = vErrors;
  return errors === 0;
}
var validateEventEnvelope = validate16;
var pattern12 = new RegExp("^[a-z_]+(\\.[a-z_]+)+$", "u");
var formats4 = require_formats().fullFormats["date-time"];
function validate16(data, { instancePath = "", parentData, parentDataProperty, rootData = data } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.id === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "id" }, message: "must have required property 'id'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.type === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "type" }, message: "must have required property 'type'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.version === void 0) {
      const err2 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "version" }, message: "must have required property 'version'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.occurred_at === void 0) {
      const err3 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "occurred_at" }, message: "must have required property 'occurred_at'" };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.tenant_id === void 0) {
      const err4 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "tenant_id" }, message: "must have required property 'tenant_id'" };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    if (data.data === void 0) {
      const err5 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "data" }, message: "must have required property 'data'" };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "id" || key0 === "type" || key0 === "version" || key0 === "occurred_at" || key0 === "tenant_id" || key0 === "data")) {
        const err6 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
    if (data.id !== void 0) {
      let data0 = data.id;
      if (typeof data0 === "string") {
        if (func3(data0) < 1) {
          const err7 = { instancePath: instancePath + "/id", schemaPath: "#/properties/id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err7];
          } else {
            vErrors.push(err7);
          }
          errors++;
        }
      } else {
        const err8 = { instancePath: instancePath + "/id", schemaPath: "#/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
    }
    if (data.type !== void 0) {
      let data1 = data.type;
      if (typeof data1 === "string") {
        if (!pattern12.test(data1)) {
          const err9 = { instancePath: instancePath + "/type", schemaPath: "#/properties/type/pattern", keyword: "pattern", params: { pattern: "^[a-z_]+(\\.[a-z_]+)+$" }, message: 'must match pattern "^[a-z_]+(\\.[a-z_]+)+$"' };
          if (vErrors === null) {
            vErrors = [err9];
          } else {
            vErrors.push(err9);
          }
          errors++;
        }
      } else {
        const err10 = { instancePath: instancePath + "/type", schemaPath: "#/properties/type/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err10];
        } else {
          vErrors.push(err10);
        }
        errors++;
      }
    }
    if (data.version !== void 0) {
      let data2 = data.version;
      if (!(typeof data2 == "number" && (!(data2 % 1) && !isNaN(data2)) && isFinite(data2))) {
        const err11 = { instancePath: instancePath + "/version", schemaPath: "#/properties/version/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err11];
        } else {
          vErrors.push(err11);
        }
        errors++;
      }
      if (typeof data2 == "number" && isFinite(data2)) {
        if (data2 < 1 || isNaN(data2)) {
          const err12 = { instancePath: instancePath + "/version", schemaPath: "#/properties/version/minimum", keyword: "minimum", params: { comparison: ">=", limit: 1 }, message: "must be >= 1" };
          if (vErrors === null) {
            vErrors = [err12];
          } else {
            vErrors.push(err12);
          }
          errors++;
        }
      }
    }
    if (data.occurred_at !== void 0) {
      let data3 = data.occurred_at;
      if (typeof data3 === "string") {
        if (!formats4.validate(data3)) {
          const err13 = { instancePath: instancePath + "/occurred_at", schemaPath: "#/properties/occurred_at/format", keyword: "format", params: { format: "date-time" }, message: 'must match format "date-time"' };
          if (vErrors === null) {
            vErrors = [err13];
          } else {
            vErrors.push(err13);
          }
          errors++;
        }
      } else {
        const err14 = { instancePath: instancePath + "/occurred_at", schemaPath: "#/properties/occurred_at/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err14];
        } else {
          vErrors.push(err14);
        }
        errors++;
      }
    }
    if (data.tenant_id !== void 0) {
      let data4 = data.tenant_id;
      if (typeof data4 === "string") {
        if (func3(data4) < 1) {
          const err15 = { instancePath: instancePath + "/tenant_id", schemaPath: "#/properties/tenant_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err15];
          } else {
            vErrors.push(err15);
          }
          errors++;
        }
      } else {
        const err16 = { instancePath: instancePath + "/tenant_id", schemaPath: "#/properties/tenant_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err16];
        } else {
          vErrors.push(err16);
        }
        errors++;
      }
    }
    if (data.data !== void 0) {
      let data5 = data.data;
      if (data5 && typeof data5 == "object" && !Array.isArray(data5)) {
      } else {
        const err17 = { instancePath: instancePath + "/data", schemaPath: "#/properties/data/type", keyword: "type", params: { type: "object" }, message: "must be object" };
        if (vErrors === null) {
          vErrors = [err17];
        } else {
          vErrors.push(err17);
        }
        errors++;
      }
    }
  } else {
    const err18 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err18];
    } else {
      vErrors.push(err18);
    }
    errors++;
  }
  validate16.errors = vErrors;
  return errors === 0;
}
var validateCheckoutRequest = validate17;
var pattern13 = new RegExp("^[A-Z]{3}$", "u");
function validate17(data, { instancePath = "", parentData, parentDataProperty, rootData = data } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.order_id === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "order_id" }, message: "must have required property 'order_id'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.amount === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "amount" }, message: "must have required property 'amount'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.currency === void 0) {
      const err2 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "currency" }, message: "must have required property 'currency'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.idempotency_key === void 0) {
      const err3 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "idempotency_key" }, message: "must have required property 'idempotency_key'" };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "order_id" || key0 === "amount" || key0 === "currency" || key0 === "provider" || key0 === "idempotency_key" || key0 === "return_url" || key0 === "metadata")) {
        const err4 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
    if (data.order_id !== void 0) {
      let data0 = data.order_id;
      if (typeof data0 === "string") {
        if (func3(data0) < 1) {
          const err5 = { instancePath: instancePath + "/order_id", schemaPath: "#/properties/order_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err5];
          } else {
            vErrors.push(err5);
          }
          errors++;
        }
      } else {
        const err6 = { instancePath: instancePath + "/order_id", schemaPath: "#/properties/order_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
    if (data.amount !== void 0) {
      let data1 = data.amount;
      if (!(typeof data1 == "number" && (!(data1 % 1) && !isNaN(data1)) && isFinite(data1))) {
        const err7 = { instancePath: instancePath + "/amount", schemaPath: "#/properties/amount/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err7];
        } else {
          vErrors.push(err7);
        }
        errors++;
      }
      if (typeof data1 == "number" && isFinite(data1)) {
        if (data1 < 1 || isNaN(data1)) {
          const err8 = { instancePath: instancePath + "/amount", schemaPath: "#/properties/amount/minimum", keyword: "minimum", params: { comparison: ">=", limit: 1 }, message: "must be >= 1" };
          if (vErrors === null) {
            vErrors = [err8];
          } else {
            vErrors.push(err8);
          }
          errors++;
        }
      }
    }
    if (data.currency !== void 0) {
      let data2 = data.currency;
      if (typeof data2 === "string") {
        if (!pattern13.test(data2)) {
          const err9 = { instancePath: instancePath + "/currency", schemaPath: "#/properties/currency/pattern", keyword: "pattern", params: { pattern: "^[A-Z]{3}$" }, message: 'must match pattern "^[A-Z]{3}$"' };
          if (vErrors === null) {
            vErrors = [err9];
          } else {
            vErrors.push(err9);
          }
          errors++;
        }
      } else {
        const err10 = { instancePath: instancePath + "/currency", schemaPath: "#/properties/currency/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err10];
        } else {
          vErrors.push(err10);
        }
        errors++;
      }
    }
    if (data.provider !== void 0) {
      let data3 = data.provider;
      if (typeof data3 === "string") {
        if (func3(data3) < 1) {
          const err11 = { instancePath: instancePath + "/provider", schemaPath: "#/properties/provider/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err11];
          } else {
            vErrors.push(err11);
          }
          errors++;
        }
      } else {
        const err12 = { instancePath: instancePath + "/provider", schemaPath: "#/properties/provider/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err12];
        } else {
          vErrors.push(err12);
        }
        errors++;
      }
    }
    if (data.idempotency_key !== void 0) {
      let data4 = data.idempotency_key;
      if (typeof data4 === "string") {
        if (func3(data4) > 255) {
          const err13 = { instancePath: instancePath + "/idempotency_key", schemaPath: "#/properties/idempotency_key/maxLength", keyword: "maxLength", params: { limit: 255 }, message: "must NOT have more than 255 characters" };
          if (vErrors === null) {
            vErrors = [err13];
          } else {
            vErrors.push(err13);
          }
          errors++;
        }
        if (func3(data4) < 1) {
          const err14 = { instancePath: instancePath + "/idempotency_key", schemaPath: "#/properties/idempotency_key/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err14];
          } else {
            vErrors.push(err14);
          }
          errors++;
        }
      } else {
        const err15 = { instancePath: instancePath + "/idempotency_key", schemaPath: "#/properties/idempotency_key/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err15];
        } else {
          vErrors.push(err15);
        }
        errors++;
      }
    }
    if (data.return_url !== void 0) {
      let data5 = data.return_url;
      if (typeof data5 === "string") {
        if (!formats0(data5)) {
          const err16 = { instancePath: instancePath + "/return_url", schemaPath: "#/properties/return_url/format", keyword: "format", params: { format: "uri" }, message: 'must match format "uri"' };
          if (vErrors === null) {
            vErrors = [err16];
          } else {
            vErrors.push(err16);
          }
          errors++;
        }
      } else {
        const err17 = { instancePath: instancePath + "/return_url", schemaPath: "#/properties/return_url/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err17];
        } else {
          vErrors.push(err17);
        }
        errors++;
      }
    }
    if (data.metadata !== void 0) {
      let data6 = data.metadata;
      if (!(data6 && typeof data6 == "object" && !Array.isArray(data6))) {
        const err18 = { instancePath: instancePath + "/metadata", schemaPath: "#/properties/metadata/type", keyword: "type", params: { type: "object" }, message: "must be object" };
        if (vErrors === null) {
          vErrors = [err18];
        } else {
          vErrors.push(err18);
        }
        errors++;
      }
    }
  } else {
    const err19 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err19];
    } else {
      vErrors.push(err19);
    }
    errors++;
  }
  validate17.errors = vErrors;
  return errors === 0;
}
var validatePayment = validate18;
var schema20 = { "$schema": "http://json-schema.org/draft-07/schema#", "$id": "https://lattice.dev/schemas/payments/payment.json", "title": "Payment", "description": "Payment record managed by the payment ledger.", "type": "object", "additionalProperties": false, "required": ["id", "order_id", "status", "amount", "currency", "provider", "idempotency_key"], "properties": { "id": { "type": "string", "description": "Unique identifier of the payment ledger record." }, "order_id": { "type": "string", "description": "Reference to the associated order." }, "user_id": { "type": "string", "description": "User who created the payment." }, "status": { "type": "string", "enum": ["pending", "succeeded", "failed", "refunded", "partially_refunded"], "description": "Current status of the payment." }, "amount": { "type": "integer", "minimum": 1, "description": "Payment amount in minor currency units." }, "currency": { "type": "string", "pattern": "^[A-Z]{3}$", "description": "Three-letter currency code." }, "provider": { "type": "string", "description": "Payment provider name." }, "provider_charge_id": { "type": "string", "description": "Charge identifier returned by the payment provider." }, "idempotency_key": { "type": "string", "description": "Client-supplied idempotency key." }, "payment_url": { "type": "string", "description": "URL for customer payment completion (if pending)." }, "created": { "type": "string", "description": "Creation timestamp." }, "updated": { "type": "string", "description": "Last update timestamp." }, "metadata": { "type": "object", "description": "Custom metadata." } } };
function validate18(data, { instancePath = "", parentData, parentDataProperty, rootData = data } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.id === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "id" }, message: "must have required property 'id'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.order_id === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "order_id" }, message: "must have required property 'order_id'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.status === void 0) {
      const err2 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "status" }, message: "must have required property 'status'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.amount === void 0) {
      const err3 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "amount" }, message: "must have required property 'amount'" };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.currency === void 0) {
      const err4 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "currency" }, message: "must have required property 'currency'" };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    if (data.provider === void 0) {
      const err5 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "provider" }, message: "must have required property 'provider'" };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    if (data.idempotency_key === void 0) {
      const err6 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "idempotency_key" }, message: "must have required property 'idempotency_key'" };
      if (vErrors === null) {
        vErrors = [err6];
      } else {
        vErrors.push(err6);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!func2.call(schema20.properties, key0)) {
        const err7 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err7];
        } else {
          vErrors.push(err7);
        }
        errors++;
      }
    }
    if (data.id !== void 0) {
      if (typeof data.id !== "string") {
        const err8 = { instancePath: instancePath + "/id", schemaPath: "#/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
    }
    if (data.order_id !== void 0) {
      if (typeof data.order_id !== "string") {
        const err9 = { instancePath: instancePath + "/order_id", schemaPath: "#/properties/order_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err9];
        } else {
          vErrors.push(err9);
        }
        errors++;
      }
    }
    if (data.user_id !== void 0) {
      if (typeof data.user_id !== "string") {
        const err10 = { instancePath: instancePath + "/user_id", schemaPath: "#/properties/user_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err10];
        } else {
          vErrors.push(err10);
        }
        errors++;
      }
    }
    if (data.status !== void 0) {
      let data3 = data.status;
      if (typeof data3 !== "string") {
        const err11 = { instancePath: instancePath + "/status", schemaPath: "#/properties/status/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err11];
        } else {
          vErrors.push(err11);
        }
        errors++;
      }
      if (!(data3 === "pending" || data3 === "succeeded" || data3 === "failed" || data3 === "refunded" || data3 === "partially_refunded")) {
        const err12 = { instancePath: instancePath + "/status", schemaPath: "#/properties/status/enum", keyword: "enum", params: { allowedValues: schema20.properties.status.enum }, message: "must be equal to one of the allowed values" };
        if (vErrors === null) {
          vErrors = [err12];
        } else {
          vErrors.push(err12);
        }
        errors++;
      }
    }
    if (data.amount !== void 0) {
      let data4 = data.amount;
      if (!(typeof data4 == "number" && (!(data4 % 1) && !isNaN(data4)) && isFinite(data4))) {
        const err13 = { instancePath: instancePath + "/amount", schemaPath: "#/properties/amount/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err13];
        } else {
          vErrors.push(err13);
        }
        errors++;
      }
      if (typeof data4 == "number" && isFinite(data4)) {
        if (data4 < 1 || isNaN(data4)) {
          const err14 = { instancePath: instancePath + "/amount", schemaPath: "#/properties/amount/minimum", keyword: "minimum", params: { comparison: ">=", limit: 1 }, message: "must be >= 1" };
          if (vErrors === null) {
            vErrors = [err14];
          } else {
            vErrors.push(err14);
          }
          errors++;
        }
      }
    }
    if (data.currency !== void 0) {
      let data5 = data.currency;
      if (typeof data5 === "string") {
        if (!pattern13.test(data5)) {
          const err15 = { instancePath: instancePath + "/currency", schemaPath: "#/properties/currency/pattern", keyword: "pattern", params: { pattern: "^[A-Z]{3}$" }, message: 'must match pattern "^[A-Z]{3}$"' };
          if (vErrors === null) {
            vErrors = [err15];
          } else {
            vErrors.push(err15);
          }
          errors++;
        }
      } else {
        const err16 = { instancePath: instancePath + "/currency", schemaPath: "#/properties/currency/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err16];
        } else {
          vErrors.push(err16);
        }
        errors++;
      }
    }
    if (data.provider !== void 0) {
      if (typeof data.provider !== "string") {
        const err17 = { instancePath: instancePath + "/provider", schemaPath: "#/properties/provider/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err17];
        } else {
          vErrors.push(err17);
        }
        errors++;
      }
    }
    if (data.provider_charge_id !== void 0) {
      if (typeof data.provider_charge_id !== "string") {
        const err18 = { instancePath: instancePath + "/provider_charge_id", schemaPath: "#/properties/provider_charge_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err18];
        } else {
          vErrors.push(err18);
        }
        errors++;
      }
    }
    if (data.idempotency_key !== void 0) {
      if (typeof data.idempotency_key !== "string") {
        const err19 = { instancePath: instancePath + "/idempotency_key", schemaPath: "#/properties/idempotency_key/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err19];
        } else {
          vErrors.push(err19);
        }
        errors++;
      }
    }
    if (data.payment_url !== void 0) {
      if (typeof data.payment_url !== "string") {
        const err20 = { instancePath: instancePath + "/payment_url", schemaPath: "#/properties/payment_url/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err20];
        } else {
          vErrors.push(err20);
        }
        errors++;
      }
    }
    if (data.created !== void 0) {
      if (typeof data.created !== "string") {
        const err21 = { instancePath: instancePath + "/created", schemaPath: "#/properties/created/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err21];
        } else {
          vErrors.push(err21);
        }
        errors++;
      }
    }
    if (data.updated !== void 0) {
      if (typeof data.updated !== "string") {
        const err22 = { instancePath: instancePath + "/updated", schemaPath: "#/properties/updated/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err22];
        } else {
          vErrors.push(err22);
        }
        errors++;
      }
    }
    if (data.metadata !== void 0) {
      let data12 = data.metadata;
      if (!(data12 && typeof data12 == "object" && !Array.isArray(data12))) {
        const err23 = { instancePath: instancePath + "/metadata", schemaPath: "#/properties/metadata/type", keyword: "type", params: { type: "object" }, message: "must be object" };
        if (vErrors === null) {
          vErrors = [err23];
        } else {
          vErrors.push(err23);
        }
        errors++;
      }
    }
  } else {
    const err24 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err24];
    } else {
      vErrors.push(err24);
    }
    errors++;
  }
  validate18.errors = vErrors;
  return errors === 0;
}
export {
  validateAppConfig,
  validateCheckoutRequest,
  validateDashboardLayout,
  validateEventEnvelope,
  validateFeatures,
  validatePayment,
  validatePluginManifest
};
