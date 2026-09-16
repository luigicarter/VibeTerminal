// Test-only browser entry. Excluded from normal and preview Vite entry graphs.
import { createAccountClient } from './client';
import {
  createAuthController,
  createBillingController,
  createDesktopApprovalController,
  createAdminController,
} from './controllers';
const client = createAccountClient({
  origin: location.origin,
  fetch: window.fetch.bind(window),
  allowLoopback: true,
});
const fixture = {
  client,
  auth: createAuthController(client),
  admin: createAdminController(client),
  billing: createBillingController(client, () => {}),
  approval: createDesktopApprovalController(client, (url) =>
    location.assign(url),
  ),
};
Object.assign(window, { __preparedAccount: fixture });
