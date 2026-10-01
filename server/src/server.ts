import express from 'express';
import { hello } from '@shared/hello';

const app = express();
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', shared: hello() });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`server on :${port}`));