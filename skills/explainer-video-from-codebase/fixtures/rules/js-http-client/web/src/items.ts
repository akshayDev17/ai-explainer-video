import axios from 'axios';
import { api, kyApi } from './client';
import { API_BASE, ROUTES } from './config';

declare function getBase(): string;

export const listItems = () => api.get('/items');
export const addTag = (id: string, tag: string) => api.post(`/items/${id}/tags`, { tag });
export const removeItem = (id: string) => kyApi.delete(`items/${id}`);
export const getItem = (id: string) => fetch(API_BASE + '/items/' + id);
export const searchItems = (q: string) => fetch(`${API_BASE}${ROUTES.items}/search?q=${q}`);
export const putItem = (id: string, body: unknown) => axios({ method: 'put', url: `${API_BASE}/items/${id}`, data: body });
export const health = () => fetch(`${process.env.SERVICE_URL}/api/v1${ROUTES.health}`);
export const countItems = () => fetch(`${getBase()}/items/count`);
export const missing = () => fetch('/api/v1/nope');
export const wrongMethod = () => fetch('/api/v1/items', { method: 'DELETE' });
