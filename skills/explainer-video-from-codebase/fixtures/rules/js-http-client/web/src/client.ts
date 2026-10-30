import axios from 'axios';
import ky from 'ky';
import { API_BASE } from './config';

export const api = axios.create({ baseURL: API_BASE });
export const kyApi = ky.create({ prefixUrl: 'http://localhost:8000/api/v1' });
