import { createApp } from "./app.js";

const port = Number(process.env.INTEGRATION_PORT ?? 4200);
createApp().listen(port, () => {
  console.log(`Integration app listening on http://localhost:${port}`);
});
