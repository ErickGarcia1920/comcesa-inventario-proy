const filtersForm = document.querySelector('#filters-form');
const inventoryBody = document.querySelector('#inventory-body');
const emptyState = document.querySelector('#empty-state');
const resultsMessage = document.querySelector('#results-message');
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
  ['search', 'warehouse', 'line', 'status'].forEach((key) => { const value = String(values.get(key) || '').trim(); if (value) query.set(key, value); });
  return query;
}

function renderInventory(data) {
  inventoryBody.replaceChildren();
  document.querySelector('#result-count').textContent = data.total;
  state.totalPages = Math.max(data.totalPages, 1);
  document.querySelector('#page-label').textContent = `Página ${data.page} de ${state.totalPages}`;
  document.querySelector('#previous-page').disabled = data.page <= 1;
  document.querySelector('#next-page').disabled = data.page >= state.totalPages;
  emptyState.hidden = data.items.length > 0;
  data.items.forEach((item) => {
    const row = document.createElement('tr');
    [item.article, item.description, item.line || '—', `${item.warehouse}${item.warehouse_name ? ` · ${item.warehouse_name}` : ''}`, item.status === 'A' ? 'Activo' : item.status, Number(item.stock).toLocaleString('es-GT', { maximumFractionDigits: 4 })].forEach((value, index) => {
      const cell = document.createElement('td'); cell.textContent = value; if (index === 5) cell.className = 'numeric'; row.appendChild(cell);
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
    document.querySelector('#user-email').textContent = data.user.email;
    await loadInventory();
  } catch (error) { if (error.message === 'UNAUTHENTICATED') window.location.replace('/login'); else resultsMessage.textContent = error.message; }
}

filtersForm.addEventListener('submit', (event) => { event.preventDefault(); state.page = 1; loadInventory(); });
document.querySelector('#previous-page').addEventListener('click', () => { if (state.page > 1) { state.page -= 1; loadInventory(); } });
document.querySelector('#next-page').addEventListener('click', () => { if (state.page < state.totalPages) { state.page += 1; loadInventory(); } });
document.querySelector('#logout-button').addEventListener('click', async () => { await apiRequest('/api/v1/auth/logout', { method: 'POST' }); window.location.replace('/login'); });
initialize();