import { LumaEvent, LumaGuest } from '../types/luma';

function str2ab(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function base64url(source: string): string {
  return btoa(source).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export class GoogleSheetsService {
  private clientEmail: string;
  private privateKey: string;
  private spreadsheetId: string;

  constructor(clientEmail: string, privateKey: string, spreadsheetId: string) {
    this.clientEmail = clientEmail;
    this.privateKey = privateKey;
    this.spreadsheetId = spreadsheetId;
  }

  private async getAccessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const header = {
      alg: "RS256",
      typ: "JWT"
    };
    const payload = {
      iss: this.clientEmail,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now
    };

    const headerBase64 = base64url(JSON.stringify(header));
    const payloadBase64 = base64url(JSON.stringify(payload));
    const toSign = `${headerBase64}.${payloadBase64}`;

    const key = await crypto.subtle.importKey(
      "pkcs8",
      str2ab(this.privateKey),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(toSign)
    );

    const signatureBase64 = base64url(
      Array.from(new Uint8Array(signature))
        .map(b => String.fromCharCode(b))
        .join("")
    );

    const jwt = `${toSign}.${signatureBase64}`;

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
    });

    const data = await response.json();
    return data.access_token;
  }

  async syncEvents(events: LumaEvent[]) {
    const accessToken = await this.getAccessToken();
    
    const headers = [
      "API ID",
      "Name",
      "Description",
      "Start Time",
      "End Time",
      "Visibility",
      "URL",
      "Cover Image",
      "Address",
      "Latitude",
      "Longitude"
    ];

    const values = events.map(event => [
      event.api_id,
      event.name,
      event.description,
      event.start_at,
      event.end_at,
      event.visibility || '',
      event.url || '',
      event.cover_url,
      event.geo_address_json?.address || '',
      event.geo_latitude || '',
      event.geo_longitude || ''
    ]);

    const response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheetId}/values/Events!A1?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          range: "Events!A1",
          majorDimension: "ROWS",
          values: [headers, ...values]
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Google Sheets API error: ${response.status} ${errorText}`);
    }

    return await response.json();
  }

  async syncGuests(eventId: string, guests: LumaGuest[]) {
    const accessToken = await this.getAccessToken();
    
    const headers = [
      "Event ID",
      "API ID",
      "Username",
      "Email",
      "Approval Status",
      "Check-in Time",
      "Created At",
      "Updated At"
    ];

    const values = guests.map(guest => [
      eventId,
      guest.api_id,
      guest.user_name,
      guest.user_email,
      guest.approval_status,
      guest.checked_in_at || '',
      guest.created_at,
      guest.updated_at
    ]);

    const response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheetId}/values/Guests!A1?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          range: "Guests!A1",
          majorDimension: "ROWS",
          values: [headers, ...values]
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Google Sheets API error: ${response.status} ${errorText}`);
    }

    return await response.json();
  }
} 