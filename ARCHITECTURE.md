# 3D Pallet Optimizer — Tổng quan

App tối ưu hoá xếp hàng lên pallet 3D cho kho/ops. Người dùng dán dữ liệu kiện hàng (Excel/CSV) → app tính toán cách xếp tối ưu → render 3D + tra cứu vị trí từng kiện cho công nhân.

## Stack

- **React 19** + **Vite 8** (ESM, no TypeScript)
- **Three.js 0.184** — render 3D viewer
- **Đơn vị:** cm và kg toàn bộ ứng dụng (xem `units_cm_only.md` trong memory)
- **UI:** dark theme, accent đỏ `#D32F2F`, font Space Grotesk + Inter + Material Symbols
- **Ngôn ngữ giao diện:** Tiếng Việt (cho ops/warehouse staff)

## Cấu trúc file

Toàn bộ logic + UI nằm trong **một file duy nhất**: `src/App.jsx` (~840 dòng). Không có thư mục `components/`, không tách module. Đây là chủ đích — giữ app gọn để dễ deploy, dễ chỉnh.

```
pallet-optimizer/
├── src/
│   ├── App.jsx          ← toàn bộ app
│   ├── App.css
│   ├── index.css
│   └── main.jsx         ← entry React
├── index.html
├── package.json
└── vite.config.js
```

## Các khối chính trong `App.jsx`

| Section                | Phạm vi (line) | Vai trò                                                                 |
|------------------------|----------------|--------------------------------------------------------------------------|
| `FontLink`             | ~5             | Inject Google Fonts (Space Grotesk, Inter, Material Symbols)             |
| `ErrorBoundary`        | ~18            | Bắt lỗi render 3D, hiện retry button                                     |
| `PALLET_PRESETS`       | ~33            | GMA 122×102×155, Square 109×109×155, Nhập tay (custom)                   |
| `parseExcelPaste()`    | ~50            | Parser dán Excel/CSV → mảng `{id, width, height, depth, weight}`         |
| `subtractBox()`        | ~71            | Cắt một space sau khi đặt kiện → trả về sub-spaces không chồng chéo      |
| `pruneContainedSpaces()` | ~103         | Loại space bị bao trọn trong space khác (tránh trùng lặp candidates)     |
| `computeSupport()`     | ~127           | Tỉ lệ đáy được đỡ — kiện không trên sàn cần ≥ 70% được đỡ                |
| `packOnePallet()`      | ~142           | Engine xếp một pallet: 6 rotation, score Y→X→Z, gap ngang, fallback no-support |
| `packAllItems()`       | ~189           | Multi-pallet: sort weight DESC + volume DESC, vòng lặp đến hết kiện      |
| `PalletViewer3D`       | ~238           | Three.js scene: pallet wireframe đỏ, bbox xanh lá đứt, kiện màu, drag/zoom |
| `StatCard`             | ~385           | Card chỉ số (Total / CHW / Stack Density / Pallet)                       |
| `SAMPLE`               | ~403           | Dữ liệu mẫu 9 kiện 50×50×50                                              |
| `ScanTab`              | ~415           | Tra cứu ID kiện (warehouse scan), nhảy thẳng đến pallet 3D               |
| `App` (default export) | ~562           | State + 3 tab (Dashboard / Scan / Settings) + sidebar pallet preset      |

## Thuật toán packing

1. **Sort kiện** theo `(weight DESC, volume DESC)` — kiện nặng và to xuống dưới trước.
2. Với mỗi pallet, bắt đầu với 1 space duy nhất (kích thước pallet).
3. Với mỗi kiện:
   - Thử 6 rotation (hoán vị 3 chiều).
   - Với mỗi (space, rotation) hợp lệ, tính `score = y·1e8 + x·1e4 + z + h·0.001` (ưu tiên thấp trước, đáy rộng trước).
   - Hai bộ "best": có support ≥ 70% và fallback không support.
   - Đặt kiện ở vị trí best.
4. **Carve space:** subtract một virtual box `(w+gap, h, d+gap)` — thêm gap chỉ chiều ngang (X, Z), chiều cao khít.
5. **Prune** spaces bị bao trọn trong space khác để giảm candidate.
6. Hết kiện hoặc không nhét được → mở pallet mới. Guard 500 vòng.

### Bounding box (CHW)

Sau khi xếp xong, mỗi pallet có `boundingBox = {w: maxX, h: maxY, d: maxZ}` của các kiện đã đặt. CHW dùng `totalBoundingVolume / 6000` (IATA) chứ KHÔNG phải full pallet volume — pallet trống một phần thì CHW chỉ tính phần thực dùng.

`Stack Density = totalActualItemVolume / totalBoundingVolume × 100%` — độ chặt khối hàng.

## Pallet presets

| Tên     | Kích thước (cm)  | Nguồn (inch)      |
|---------|------------------|-------------------|
| GMA     | 122 × 102 × 155  | 48 × 40 × 61 in   |
| Square  | 109 × 109 × 155  | 43 × 43 × 61 in   |
| Nhập tay | tuỳ chỉnh W/H/D  | —                 |

Default gap ngang: **1.5 cm** (đủ cho công nhân kê tay).

## Các tab UI

- **Dashboard** — input area + bảng kiện đã xếp + 3D viewer; click row để highlight kiện trong 3D.
- **Warehouse Scan** — gõ/scan ID, hiện vị trí (X/Y/Z, tầng, thứ tự xếp), button "Xem vị trí 3D" nhảy về Dashboard với highlight.
- **Settings** — có nav button nhưng chưa có nội dung (tab placeholder).

## State chính (App component)

| State          | Vai trò                                       |
|----------------|-----------------------------------------------|
| `raw`          | Text Excel/CSV đang nhập                      |
| `result`       | Output của `packAllItems()` (pallets, CHW…)   |
| `running`      | Loading khi optimize                          |
| `timing`       | Thời gian tính (giây)                         |
| `activePallet` | Pallet đang xem trong 3D                      |
| `tab`          | "dashboard" / "scan" / "settings"             |
| `highlightId`  | ID kiện đang được highlight trong 3D          |
| `presetIdx`    | Index pallet preset đang chọn                 |
| `customW/H/D`  | Custom pallet dimensions                      |
| `gap`          | Khoảng hở ngang (cm)                          |

## Lookup table (cho Scan tab)

`packAllItems()` tạo `result.lookup[id] = { palletIndex, palletNum, order, item }` — map ID → vị trí pallet + thứ tự đặt vào.

## Format input

```
ID, Width, Height, Depth, Weight
BOX-001, 50, 50, 50, 25
BOX-002, 40, 30, 20, 12
```

Hỗ trợ phân cách bằng tab (paste từ Excel) hoặc dấu phẩy. Bỏ qua dòng < 5 cột hoặc dòng có giá trị non-numeric.

## Build & Run

```bash
npm install
npm run dev      # dev server
npm run build    # production build → dist/
npm run preview  # preview dist
npm run lint     # ESLint
```
