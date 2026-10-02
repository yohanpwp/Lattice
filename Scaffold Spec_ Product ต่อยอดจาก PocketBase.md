# Scaffold Spec: Product ต่อยอดจาก PocketBase

เอกสารนี้กำหนดโครงของ **backend**, **contracts** และ **UI** พร้อมระบุว่าส่วนใด *คงไว้จาก PocketBase* ส่วนใดเพิ่มใหม่

**สัญลักษณ์**

- `[KEEP]` ใช้ของ PocketBase ตามเดิม ไม่แก้ source
- `[ADD]` โค้ดใหม่ของเรา
- `[ADAPT]` ใช้ของ PocketBase แต่ปรับการตั้งค่า/การใช้งาน (ยังไม่แก้ source)

**หลักการ**

1. ใช้ PocketBase เป็น Go framework แล้วครอบด้วยโค้ดเรา ไม่เขียนทับ core
2. Contract (สิ่งที่ client และ plugin พึ่งพา) ต้องกำหนดและใส่เวอร์ชันตั้งแต่วันแรก
3. UI ทุกแพลตฟอร์มแชร์ contract, SDK และ logic แยกเฉพาะชั้น render

---

## 1. โครงรวมของ repo

```
yourproduct/
├── backend/            # Go module: server บน PocketBase
├── third_party/
│   └── pocketbase/     # [KEEP] (ทางเลือก) fork แยก repo/submodule เมื่อจำเป็นต้อง patch
├── contracts/          # [ADD] แหล่งความจริงของ API/schema
├── packages/           # [ADD] TypeScript ใช้ร่วม: types, sdk, ui-core, ui-web
├── apps/               # [ADD] client (web+desktop), desktop, mobile
├── tools/              # [ADD] codegen, license scan
├── LICENSE-PRODUCT.md  NOTICE  THIRD_PARTY_LICENSES
└── pnpm-workspace.yaml  turbo.json  go.work
```

---

## 2. Backend

### 2.1 โครงไฟล์

```
backend/
├── cmd/server/main.go            # [ADD] pocketbase.New() + ลงทะเบียน platform/plugins
├── internal/
│   ├── platform/                 # [ADD] (ไม่ใช้ชื่อ core/ เพื่อไม่ชนกับ package ของ PocketBase)
│   │   ├── registry/             #   plugin registry + manifest loader
│   │   ├── outbox/               #   outbox collection + worker (retry, ลำดับ)
│   │   ├── features/             #   feature flags ต่อ tenant
│   │   ├── tenant/               #   tenant config loader (จาก control plane)
│   │   └── secrets/              #   อ่าน secret จาก secret store
│   ├── api/                      # [ADD] custom routes /v1/*
│   ├── plugins/
│   │   └── payments/             # [ADD] interface, ledger, webhook, providers/
│   └── migrations/               # [ADD] ต่อท้ายระบบ migration ของ PocketBase
├── pb_hooks/                     # [KEEP] JS hooks (ทางเลือก, logic เบา)
├── pb_data/                      # [KEEP] SQLite + ไฟล์ (volume ต่อ tenant)
├── go.mod                        # require pocketbase (pin เวอร์ชัน)
└── Dockerfile
```

### 2.2 ส่วนที่คงไว้จาก PocketBase

| ส่วน | สถานะ | หมายเหตุ |
| --- | --- | --- |
| Collections / Records API + API rules | `[KEEP]` | แกนข้อมูล ปรับ rule ต่อ tenant |
| Auth (password, OAuth2/OIDC) | `[KEEP]` | ตั้งค่าตอน provisioning |
| Realtime (SSE) | `[KEEP]` | client ต้องมี EventSource polyfill บน React Native |
| File storage | `[KEEP]` |  |
| ระบบ migration / backup / logs | `[KEEP]` | migration ของเราต่อท้าย |
| JS hooks (`pb_hooks`) | `[KEEP]` | ทางเลือก ต้อง restart เมื่อเปลี่ยน |
| Admin UI ของ PocketBase | `[ADAPT]` | ใช้ภายในทีมเท่านั้น (superuser) ไม่เปิดให้ลูกค้า |
| Settings (SMTP, S3, OAuth) | `[ADAPT]` | control plane เป็นผู้ provision ต่อ tenant |
| Token/secret ต่อ instance | `[KEEP]` | token ของ tenant หนึ่งใช้กับอีก tenant ไม่ได้ |

### 2.3 ส่วนที่เพิ่ม (หน้าที่)

- **registry**: โหลด manifest ของ plugin, ตรวจเวอร์ชันของ interface, เปิด/ปิดตาม features
- **outbox**: เขียน event ลงตารางใน transaction เดียวกับข้อมูลหลัก แล้ว worker ส่งพร้อม retry
- **features**: อ่านไฟล์ features ต่อ tenant ที่ control plane เขียนให้
- **api**: `/v1/config`, `/v1/features`, endpoint aggregate สำหรับ dashboard, webhook ของ payments
- **payments**: `PaymentProvider` interface (มี context, idempotency key, partial refund), ledger (unique index บน `provider_charge_id`), webhook ที่ verify จาก raw body และตรวจ amount/currency

### 2.4 โครง `main.go`

```go
package main

import (
	"log"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"

	"yourproduct/backend/internal/api"
	"yourproduct/backend/internal/platform/registry"
	_ "yourproduct/backend/internal/plugins/payments" // init() ลงทะเบียน plugin
)

func main() {
	app := pocketbase.New()

	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		api.Register(se, registry.Default)
		return se.Next()
	})

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}
```

ตรวจชื่อ method กับเอกสารของเวอร์ชันที่ pin ไว้ก่อนใช้จริง

### 2.5 Plugin manifest (ตัวอย่าง)

```yaml
name: payments
version: 0.1.0
interface_version: 1        # เวอร์ชันของ PaymentProvider interface
license: Proprietary
requires: [outbox]
permissions: [collections:payment_ledger, events:emit]
```

### 2.6 กติกา

- Pin เวอร์ชัน PocketBase; อ่าน release notes ก่อนอัปเกรด
- Hook ทุกตัวต้องเรียก `e.Next()`
- Plugin ห้ามแตะตาราง SQLite ตรง ต้องผ่าน service layer
- ถ้าต้อง patch core: ทำใน fork แยก repo (`replace` ใน `go.mod`) และบันทึกใน `docs/patches.md`

---

## 3. Contracts

```
contracts/
├── openapi.yaml           # [ADD] เฉพาะ /v1/* (custom routes)
├── schemas/
│   ├── app-config.json    # config ที่ client ได้รับ
│   ├── features.json
│   ├── dashboard-layout.json
│   ├── plugin-manifest.json
│   └── events/            # payload ของ event/webhook (มี version)
└── collections/           # นิยาม collection/features ต่อ tenant (ห้ามมี secret)
```

**ส่วนที่คงจาก PocketBase:** endpoint `/api/collections/...`, `/api/realtime` ไม่ถูกเขียนซ้ำใน OpenAPI ของเรา ให้ client เรียกผ่าน SDK ซึ่งห่อ PocketBase JS SDK ไว้ เพื่อให้เปลี่ยนรุ่นของ PocketBase ได้โดยไม่กระทบ client

**กฎ**

- `/v1` สำหรับ custom API, มี `schema_version` และ `min_client_version` ใน config
- ทุก schema ใน `schemas/` เป็นต้นทาง gen `packages/types` และ validator ฝั่ง Go
- Contract test: implementation จริง + fake ต้องผ่านชุดเดียวกัน
- Event/webhook payload ใส่ `version` เสมอ

---

## 4. UI

```
packages/
├── types/      # gen จาก contracts
├── sdk/        # client บน PocketBase JS SDK + platform adapters
├── ui-core/    # logic ไม่มี UI: widget registry, layout, hooks
├── ui-web/     # component สำหรับ DOM (web + desktop)
└── config/
apps/
├── client/     # Vite + React SPA (ใช้ทั้ง web และ desktop)
├── desktop/    # Tauri v2 ห่อ apps/client
├── mobile/     # Capacitor shell (เริ่มต้น) หรือ React Native เมื่อจำเป็น
├── site/       # (ทางเลือก) Next.js สำหรับ marketing/SEO
└── admin/      # (ทางเลือก) Builder/แผงจัดการ plugin
```

### 4.1 ส่วนที่คงจาก PocketBase ฝั่ง UI

| ส่วน | สถานะ |
| --- | --- |
| PocketBase JS SDK (MIT) เป็นชั้น transport ใน `sdk/` | `[KEEP]` |
| รูปแบบ API `/api/collections/{name}/records`, filter/sort | `[KEEP]` |
| Auth store (ใช้ custom store ต่อแพลตฟอร์ม) | `[KEEP]` + `[ADAPT]` |
| Realtime SSE | `[KEEP]` |
| Admin UI ของ PocketBase | ไม่ใช้ในแอปลูกค้า |
| Dashboard/Builder/Widget/Feature-aware UI | `[ADD]` |

### 4.2 Platform adapters (interface เดียว, implementation ต่อแพลตฟอร์ม)

| ความสามารถ | Web | Desktop (Tauri) | Mobile |
| --- | --- | --- | --- |
| เก็บ token | cookie/localStorage | OS keychain | SecureStore/Keychain |
| Realtime | EventSource | EventSource | EventSource polyfill |
| ไฟล์/แจ้งเตือน/deep link | browser API | Tauri plugin | Capacitor/native plugin |

### 4.3 กติกา

- Client อ่าน `backend_url` จาก config เสมอ ไม่ hardcode
- Dashboard เป็น server-driven (JSON layout); แต่ละแพลตฟอร์มมี renderer ของ widget type เดียวกัน widget ที่ไม่รองรับแสดง fallback
- Filter ต้อง bind parameter ห้ามต่อ string; `props` ของ widget ผ่าน whitelist ตาม schema
- ตรวจ `res.ok` ก่อน parse ทุกครั้ง

---

## 5. สรุป: ส่วนที่คงจาก PocketBase

| ชั้น | คงไว้ | เพิ่ม/ปรับ |
| --- | --- | --- |
| Backend | collections, auth, realtime, files, migrations, backup, JS hooks, token ต่อ instance | registry, outbox, features, `/v1/*`, payments, secrets, tenant config |
| Contracts | รูปแบบ `/api/*` (ไม่เขียนซ้ำ) | `/v1` + schemas + events |
| UI | JS SDK, auth store, SSE, API shape | ui-core, ui-web, renderer ต่อแพลตฟอร์ม, builder |

---

## 6. License & compliance

- คง `LICENSE.md` ของ PocketBase (MIT) ไม่แก้; ไฟล์ license ของเราตั้งชื่ออื่น (`LICENSE-PRODUCT.md`)
- แนบ notice ใน binary, bundle web, installer desktop และแอป mobile
- CI สร้าง `THIRD_PARTY_LICENSES` อัตโนมัติ และ fail ถ้ามี dependency นอก allowlist (GPL/AGPL/BSL/OSL)
- ไม่คัดลอกโค้ด/สคีมา/เอกสารจาก Directus หรือ TrailBase (ใช้เฉพาะแนวคิด)
- ตรวจ license ของ SDK ของ payment provider ก่อนใช้

---

## 7. ลำดับ milestone

- **M0** `backend/` รันได้บน PocketBase + Dockerfile + `/v1/config`
- **M1** `contracts/` + gen types + `sdk` พร้อม adapter
- **M2** registry + outbox + features
- **M3** `apps/client` (login, dashboard) แล้วห่อ Tauri
- **M4** payments plugin (ledger ก่อน แล้วค่อย provider ตัวแรก)
- **M5** mobile (Capacitor) และ CI license scan ครบ

<!-- แผนสำหรับพิจารณาภายหลัง: Excel import / schema suggestion
Excel ในคำอธิบายธุรกิจเป็นเพียงตัวอย่างของข้อมูลแบบตารางที่ผู้ใช้คุ้นเคย ไม่ใช่ข้อกำหนดให้สร้าง schema จากไฟล์โดยตรง
MVP ปัจจุบันไม่รวมการนำเข้า Excel การจับคู่คอลัมน์ หรือการสร้าง/เสนอ schema อัตโนมัติจาก workbook
หากมีความต้องการภายหลัง อาจพิจารณา preview ข้อมูล การจับคู่คอลัมน์ การยืนยัน schema และรายงานข้อผิดพลาดก่อนบันทึกจริง
ยังไม่กำหนด milestone เทคโนโลยี หรือรายละเอียด implementation สำหรับแนวคิดนี้
-->
## 8. ข้อตัดสินใจที่ยังเปิดอยู่

- Mobile: Capacitor (UI ชุดเดียว) หรือ React Native (native UX)
- ใช้ Vite SPA หรือ Next.js (static export) เป็นแอปหลัก
- ใช้ PocketBase เป็น library ล้วน หรือมี fork ไว้ patch
- วิธี deploy ช่วงแรก (VM + reverse proxy หรือ Kubernetes)

*เอกสารนี้เป็นข้อมูลทั่วไป ไม่ใช่คำปรึกษาทางกฎหมาย ควรให้ทนายตรวจเรื่อง license ก่อนจำหน่ายจริง*