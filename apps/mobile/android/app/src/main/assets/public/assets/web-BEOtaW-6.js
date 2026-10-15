import { S as s } from "./base-C20ZxNo8.js";
import "./index-xmRiI_dm.js";
class c extends s {
  async setSynchronizeKeychain(e) {}
  async internalGetItem(e) {
    return { data: localStorage.getItem(e.prefixedKey) };
  }
  async internalSetItem(e) {
    localStorage.setItem(e.prefixedKey, e.data);
  }
  async internalRemoveItem(e) {
    return localStorage.getItem(e.prefixedKey) !== null
      ? (localStorage.removeItem(e.prefixedKey), { success: !0 })
      : { success: !1 };
  }
  async clear() {
    const { keys: e } = await this.getPrefixedKeys({ prefix: this.prefix });
    for (const t of e) localStorage.removeItem(t);
  }
  async clearItemsWithPrefix(e) {
    console.warn("clearItemsWithPrefix is native only");
  }
  async getPrefixedKeys(e) {
    const t = [];
    for (let a = 0; a < localStorage.length; a++) {
      const r = localStorage.key(a);
      r != null && r.startsWith(e.prefix) && t.push(r);
    }
    return { keys: t };
  }
}
export { c as SecureStorageWeb };
