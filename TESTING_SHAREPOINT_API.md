# Testing SharePoint Sites API

## Endpoint
```
GET /api/integrations/microsoft/sites
```

## Authentication

The API uses NextAuth session cookies. You need to be logged in to your app first.

### Step 1: Get Your Session Cookie

1. **Open your browser** and log in to your app at `http://localhost:3000` (or your dev URL)
2. **Open Developer Tools** (F12 or Cmd+Option+I)
3. Go to **Application** tab (Chrome) or **Storage** tab (Firefox)
4. Find **Cookies** → `http://localhost:3000` (or your domain)
5. Look for a cookie named `authjs.session-token` (or similar NextAuth cookie)
6. **Copy the cookie value**

### Step 2: Test with curl

#### Basic request (get all sites):
```bash
curl -X GET "http://localhost:3000/api/integrations/microsoft/sites" \
  -H "Cookie: authjs.session-token=YOUR_SESSION_TOKEN_HERE" \
  -H "Content-Type: application/json"
```

#### With query parameter (search/filter):
```bash
curl -X GET "http://localhost:3000/api/integrations/microsoft/sites?query=adventureflow" \
  -H "Cookie: authjs.session-token=YOUR_SESSION_TOKEN_HERE" \
  -H "Content-Type: application/json"
```

#### Query specific site by URL:
```bash
curl -X GET "http://localhost:3000/api/integrations/microsoft/sites?query=https://adventureflow.sharepoint.com/sites/AdventureFlow" \
  -H "Cookie: authjs.session-token=YOUR_SESSION_TOKEN_HERE" \
  -H "Content-Type: application/json"
```

### Step 3: Test with Postman

1. **Create a new GET request**
   - URL: `http://localhost:3000/api/integrations/microsoft/sites`
   
2. **Add Headers:**
   - Key: `Cookie`
   - Value: `authjs.session-token=YOUR_SESSION_TOKEN_HERE`

3. **Add Query Parameters (optional):**
   - Key: `query`
   - Value: `adventureflow` (or full URL)

4. **Send the request**

### Alternative: Use Browser's Copy as cURL

1. Open your app in the browser
2. Open **Developer Tools** → **Network** tab
3. Navigate to the integrations page (which will call the sites API)
4. Find the request to `/api/integrations/microsoft/sites`
5. Right-click → **Copy** → **Copy as cURL**
6. Paste into terminal - it will include all cookies automatically!

### Expected Response Format

**Success (200):**
```json
{
  "sites": [
    {
      "id": "site-id-here",
      "name": "Site Name",
      "webUrl": "https://adventureflow.sharepoint.com/sites/AdventureFlow"
    }
  ]
}
```

**Error (401):**
```json
{
  "error": "Unauthorized"
}
```

**Error (400):**
```json
{
  "error": "Failed to list sites"
}
```

### Troubleshooting

1. **401 Unauthorized**: Make sure you're logged in and the session cookie is valid
2. **Cookie not found**: The cookie name might be different. Check all cookies in DevTools
3. **Empty sites array**: Make sure you've connected Microsoft integration first via the UI
4. **Connection issues**: Ensure your dev server is running and Microsoft integration is configured

### Testing Direct Microsoft Graph API

If you want to test Microsoft Graph API directly (bypassing your app), you'll need an access token:

```bash
# Get access token (requires OAuth flow or Azure CLI)
# Then test Graph API directly:
curl -X GET "https://graph.microsoft.com/v1.0/sites/getAllSites" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN_HERE"
```

Or test specific site:
```bash
curl -X GET "https://graph.microsoft.com/v1.0/sites/adventureflow.sharepoint.com:/sites/AdventureFlow" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN_HERE"
```

