import { resetClock } from './clock';

jest.mock('./mailer');

beforeEach(() => {
  resetClock();
});
