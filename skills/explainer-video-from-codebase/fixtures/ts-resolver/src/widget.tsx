import React from 'react';
import { format } from './util';

class Widget extends React.Component {
  render() {
    return <span>{format('w')}</span>;
  }
}

export function Page() {
  return <Widget />;
}
