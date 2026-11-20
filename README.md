# Xyron Wholesale API

Standalone Express API for the Xyron Wholesale application. The Xyron WebTech client is maintained and deployed separately.

## Requirements

- Node.js 22.5 or later
- MongoDB (local or Atlas)
- Cloudinary credentials for image uploads
- India Post PIN lookup API for delivery location details
- Optional PIN directory SQLite database for state/district lists and PIN-area maps

## Local development

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy `.env.example` to `.env`. Set `JWT_SECRET` to a random value of at least 32 characters and configure `MONGODB_URI`. Set `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` before creating the first admin.
3. Start the API:

   ```sh
   npm run dev
   ```

The API listens on `http://localhost:5000/api` by default. Configure `CLIENT_ORIGIN` to the client origin; local development also permits the matching `localhost` and `127.0.0.1` origins.

Create or synchronize the initial Super Admin with:

```sh
npm run seed:super-admin
```

Checkout resolves customer and business locations with the India Post API at `https://api.postalpincode.in/pincode/{PIN}`. If a PIN has no delivery rate or the lookup is unavailable, the order can still be placed with its delivery charge pending. The optional SQLite PIN directory is used only for state/district lists and approximate PIN-area maps; set `XYRON_PIN_DATABASE_PATH` to its absolute path when available. Image uploads require either `CLOUDINARY_URL` or all three split Cloudinary values.

## Production

Deploy this repository as a Node.js service and configure environment variables in the hosting provider; never commit production values. Required settings are `NODE_ENV=production`, `CLIENT_ORIGIN` (the exact public client origin), `JWT_SECRET`, and `MONGODB_URI`. Configure Cloudinary for image uploads and `XYRON_PIN_DATABASE_PATH` if the optional regions/map database is available on the host.

The API uses a MongoDB connection pool with `MONGODB_MAX_POOL_SIZE=100` by default. This limit applies per API instance, so size it against the MongoDB connection limit and the maximum number of simultaneously running instances. Public store metadata is shared-cacheable for 15 seconds and product listings for 5 seconds; order placement always checks current stock in MongoDB. The health endpoint reports unavailable while MongoDB is disconnected, and the server drains requests on shutdown.

The in-process rate-limit store is not shared across instances. Before scaling the API horizontally, configure a shared rate-limit store and verify the Render instance plan and MongoDB tier against the expected peak concurrency. A code change alone cannot guarantee capacity for 200 concurrent users.

The client uses `VITE_API_URL` at build time, set to the API's HTTPS URL ending in `/api`. The API does not serve the client static files. Use HTTPS and restrict CORS to the production client origin.

## Checks

```sh
npm run check
npm test
```

Tests that need the optional PIN database are skipped when it is unavailable.
