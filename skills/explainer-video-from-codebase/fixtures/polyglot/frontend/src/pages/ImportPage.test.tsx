import { render, fireEvent } from '@testing-library/react';
import { ImportPage } from './ImportPage';
import { importBooks } from '../api/catalog';

jest.mock('../api/catalog');

it('starts an import when the button is pressed', () => {
  const view = render(<ImportPage />);
  fireEvent.click(view.getByText('Import'));
  expect(importBooks).toHaveBeenCalledWith('s');
});
