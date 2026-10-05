import PocketBase, { type RecordModel } from "pocketbase";

export class PaymentsApi {
    readonly pb: PocketBase;

    constructor(pb: PocketBase, arg: Function) {
    this.pb = pb;
  }
}