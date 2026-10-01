import React from 'react';
import ReactDOM from 'react-dom/client';
import { hello } from '@shared/hello';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div>web: {hello()}</div>
  </React.StrictMode>
);