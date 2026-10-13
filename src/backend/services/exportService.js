const ExcelJS = require('exceljs');

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const STATUS_LABELS = { A: 'Activo', I: 'Inactivo' };

const COLUMNS = [
  { header: 'Artículo', width: 18 },
  { header: 'Descripción', width: 52 },
  { header: 'Línea', width: 12 },
  { header: 'Unidad', width: 9 },
  { header: 'Bodega', width: 9, numeric: true },
  { header: 'Nombre de bodega', width: 22 },
  { header: 'Estado', width: 11 },
  { header: 'Existencia', width: 14, numeric: true }
];

// Fecha y hora de Guatemala, por ejemplo "2026-10-13 14:05".
function guatemalaStamp(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Guatemala',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(date);
}

function sortLabel(filters) {
  switch (filters.sort) {
    case 'description': return 'Descripción';
    case 'warehouse': return 'Bodega';
    case 'stock': return filters.direction === 'asc' ? 'Existencia (menor a mayor)' : 'Existencia (mayor a menor)';
    default: return 'Clave de artículo';
  }
}

// Escribe el libro de Excel directamente en la respuesta (sin armarlo completo en memoria).
async function writeInventoryWorkbook(response, rows, filters) {
  const now = new Date();
  const stamp = guatemalaStamp(now);
  const fileStamp = stamp.replace(' ', '_').replace(':', '');

  response.setHeader('Content-Type', XLSX_TYPE);
  response.setHeader('Content-Disposition', `attachment; filename="inventario_${fileStamp}.xlsx"`);
  response.setHeader('Cache-Control', 'no-store');

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: response, useStyles: true, useSharedStrings: true });
  workbook.creator = 'COMCESA Inventario';
  workbook.created = now;

  // Hoja 1: datos. Los textos se escriben como texto (las claves como 03E2191 o 00151 no se alteran).
  const sheet = workbook.addWorksheet('Inventario', {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { tabColor: { argb: 'FF0869A8' } }
  });
  sheet.columns = COLUMNS.map((column) => ({ width: column.width }));
  sheet.autoFilter = `A1:${String.fromCharCode(64 + COLUMNS.length)}${rows.length + 1}`;

  const header = sheet.addRow(COLUMNS.map((column) => column.header));
  header.height = 22;
  header.eachCell((cell, columnNumber) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF063B68' } };
    cell.alignment = { vertical: 'middle', horizontal: COLUMNS[columnNumber - 1].numeric ? 'right' : 'left' };
  });
  header.commit();

  for (const item of rows) {
    const stock = Number(item.stock);
    const row = sheet.addRow([
      String(item.article ?? ''),
      String(item.description ?? ''),
      String(item.line ?? ''),
      String(item.unit ?? ''),
      Number(item.warehouse),
      String(item.warehouse_name ?? '').trim(),
      STATUS_LABELS[item.status] || String(item.status ?? ''),
      stock
    ]);
    row.getCell(8).numFmt = Number.isInteger(stock) ? '#,##0' : '#,##0.00##';
    row.commit();
  }
  sheet.commit();

  // Hoja 2: con qué filtros se generó el archivo.
  const info = workbook.addWorksheet('Filtros');
  info.columns = [{ width: 26 }, { width: 44 }];
  const infoRows = [
    ['Fecha de descarga', stamp],
    ['Búsqueda', filters.search || 'Todos'],
    ['Clave desde', filters.articleFrom ? filters.articleFrom.toUpperCase() : '—'],
    ['Clave hasta', filters.articleTo ? filters.articleTo.toUpperCase() : '—'],
    ['Bodega', filters.warehouse ?? 'Todas'],
    ['Línea', filters.line || 'Todas'],
    ['Estado', STATUS_LABELS[filters.status] || 'Todos'],
    ['Orden', sortLabel(filters)],
    ['Registros exportados', rows.length],
    ['Nota', 'Solo se incluyen registros con existencia mayor a cero.']
  ];
  for (const [label, value] of infoRows) {
    const row = info.addRow([label, value]);
    row.getCell(1).font = { bold: true };
    row.getCell(2).alignment = { horizontal: 'left' };
    row.commit();
  }
  info.commit();

  await workbook.commit();
}

module.exports = { writeInventoryWorkbook };
