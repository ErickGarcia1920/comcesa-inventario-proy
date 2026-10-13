const filtersForm = document.querySelector('#filters-form');
const inventoryBody = document.querySelector('#inventory-body');
const emptyState = document.querySelector('#empty-state');
const resultsMessage = document.querySelector('#results-message');
const exportButton = document.querySelector('#export-button');
const exportLabel = document.querySelector('#export-label');
const state = { page: 1, totalPages: 1 };

async function apiRequest(url, options = {}) {
  const response = await fetch(url, { ...options, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  if (response.status === 401) throw new Error('UNAUTHENTICATED');
  if (!response.ok) throw new Error('No fue posible cargar el inventario');
  return response.status === 204 ? null : response.json();
}

function queryString() {
  const values = new FormData(filtersForm);
  const query = new URLSearchParams({ page: String(state.page), limit: '20', sort: values.get('sort') || 'article' });
  ['search', 'articleFrom', 'articleTo', 'warehouse', 'line', 'status'].forEach((key) => { const value = String(values.get(key) || '').trim(); if (value) query.set(key, value); });
  return query;
}

function renderInventory(data) {
  inventoryBody.replaceChildren();
  document.querySelector('#result-count').textContent = data.total;
  exportButton.disabled = data.total === 0;
  state.totalPages = Math.max(data.totalPages, 1);
  document.querySelector('#page-label').textContent = `Página ${data.page} de ${state.totalPages}`;
  document.querySelector('#previous-page').disabled = data.page <= 1;
  document.querySelector('#next-page').disabled = data.page >= state.totalPages;
  emptyState.hidden = data.items.length > 0;
  data.items.forEach((item) => {
    const row = document.createElement('tr');
    const stock = Number(item.stock);
    const statusText = item.status === 'A' ? 'Activo' : (item.status === 'I' ? 'Inactivo' : item.status);
    const cells = [
      { col: 'article', label: '', value: item.article },
      { col: 'description', label: '', value: item.description },
      { col: 'line', label: 'Línea', value: item.line || '—' },
      { col: 'warehouse', label: 'Bodega', value: `${item.warehouse}${item.warehouse_name ? ` · ${item.warehouse_name}` : ''}` },
      { col: 'status', label: '', value: statusText, badge: item.status === 'A' ? 'badge-active' : 'badge-inactive' },
      { col: 'stock', label: 'Existencia', value: stock.toLocaleString('es-GT', { maximumFractionDigits: 4 }), className: stock <= 0 ? 'numeric stock-zero' : 'numeric' }
    ];
    cells.forEach((cellData) => {
      const cell = document.createElement('td');
      cell.dataset.col = cellData.col;
      if (cellData.label) cell.dataset.label = cellData.label;
      if (cellData.className) cell.className = cellData.className;
      if (cellData.badge) {
        const badge = document.createElement('span');
        badge.className = `badge ${cellData.badge}`;
        badge.textContent = cellData.value;
        cell.appendChild(badge);
      } else {
        cell.textContent = cellData.value;
      }
      row.appendChild(cell);
    });
    inventoryBody.appendChild(row);
  });
}

async function loadInventory() {
  resultsMessage.textContent = 'Cargando inventario...';
  try { renderInventory(await apiRequest(`/api/v1/inventory?${queryString()}`)); resultsMessage.textContent = ''; }
  catch (error) { if (error.message === 'UNAUTHENTICATED') window.location.replace('/login'); else resultsMessage.textContent = error.message; }
}

async function initialize() {
  try {
    const data = await apiRequest('/api/v1/auth/me');
    if (data.user.mustChangePassword) { window.location.replace('/cambiar-password'); return; }
    document.querySelector('#user-email').textContent = data.user.email;
    if (data.user.role === 'admin') document.querySelector('#admin-link').hidden = false;
    await loadInventory();
  } catch (error) { if (error.message === 'UNAUTHENTICATED') window.location.replace('/login'); else resultsMessage.textContent = error.message; }
}

// Descarga en Excel con los filtros que estan en pantalla (sin paginar).
async function exportExcel() {
  const query = queryString();
  query.delete('page');
  query.delete('limit');
  exportButton.disabled = true;
  exportLabel.textContent = 'Preparando archivo...';
  resultsMessage.textContent = '';
  try {
    const response = await fetch(`/api/v1/inventory/export?${query}`, { credentials: 'same-origin' });
    if (response.status === 401) { window.location.replace('/login'); return; }
    if (!response.ok) {
      let message = 'No fue posible generar el archivo de Excel';
      try { const body = await response.json(); if (body.message) message = body.message; } catch { /* sin detalle */ }
      throw new Error(message);
    }
    const blob = await response.blob();
    const match = (response.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = match ? match[1] : 'inventario.xlsx';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (error) {
    resultsMessage.textContent = error.message;
  } finally {
    exportButton.disabled = false;
    exportLabel.textContent = 'Descargar Excel';
  }
}

exportButton.addEventListener('click', exportExcel);
filtersForm.addEventListener('submit', (event) => { event.preventDefault(); state.page = 1; loadInventory(); });
document.querySelector('#previous-page').addEventListener('click', () => { if (state.page > 1) { state.page -= 1; loadInventory(); } });
document.querySelector('#next-page').addEventListener('click', () => { if (state.page < state.totalPages) { state.page += 1; loadInventory(); } });
document.querySelector('#logout-button').addEventListener('click', async () => { await apiRequest('/api/v1/auth/logout', { method: 'POST' }); window.location.replace('/login'); });
initialize();