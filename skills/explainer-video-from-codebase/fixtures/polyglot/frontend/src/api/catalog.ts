import axios from 'axios';

const BASE = '/api/v1';

export async function searchBooks(shelf: string, q: string) {
  return fetch(`/api/v1/catalog/shelves/${shelf}/books/search`, { method: 'POST', body: JSON.stringify({ q }) });
}

export async function searchReviews(shelf: string, q: string) {
  return fetch(`${BASE}/catalog/shelves/${shelf}/reviews/search`, { method: 'POST' });
}

export async function importBooks(shelf: string) {
  return axios.post(`/api/v1/ingest/shelves/${shelf}/books/import`);
}

export async function jobStatus(id: string) {
  return axios.get(`/api/v1/ingest/jobs/${id}`);
}
