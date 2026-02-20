import * as msal from '@azure/msal-node';
import jwt from 'jsonwebtoken';

/**
 * MSAL Configuration
 */
const msalConfig = {
    auth: {
        clientId: process.env.AZURE_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
        clientSecret: process.env.AZURE_CLIENT_SECRET,
    }
};

const pca = new msal.ConfidentialClientApplication(msalConfig);

/**
 * Generate Authorization URL
 * @param {string} prompt - Optional prompt parameter ('select_account' to show account picker)
 */
export async function getAuthUrl(prompt = null) {
    const authCodeUrlParameters = {
        scopes: [
            "user.read",
            "OnlineMeetings.Read",
            "OnlineMeetingTranscript.Read.All",
            "OnlineMeetingRecording.Read.All",
            "Calendars.Read",
            "Files.Read",
            "Files.Read.All",
            "Sites.Read.All"
        ],
        redirectUri: process.env.AZURE_REDIRECT_URI,
    };

    // Add prompt parameter if provided (e.g., 'select_account' to show account picker)
    if (prompt === 'select_account') {
        authCodeUrlParameters.prompt = 'select_account';
    }

    return await pca.getAuthCodeUrl(authCodeUrlParameters);
}

/**
 * Exchange Code for Token
 */
export async function getTokenFromCode(code) {
    const tokenRequest = {
        code: code,
        scopes: [
            "user.read",
            "OnlineMeetings.Read",
            "OnlineMeetingTranscript.Read.All",
            "OnlineMeetingRecording.Read.All",
            "Calendars.Read",
            "Files.Read",
            "Files.Read.All",
            "Sites.Read.All"
        ],
        redirectUri: process.env.AZURE_REDIRECT_URI,
    };

    const response = await pca.acquireTokenByCode(tokenRequest);
    return response;
}

/**
 * Extract User ID (OID) from Request Cookies
 * This allows us to scope data to the specific logged-in user.
 */
export function getUserIdFromRequest(req) {
    try {
        const tokenCookie = req.cookies.get('ms_token');
        // Handle both NextRequest (map-like) and standard request (obj-like)
        const token = tokenCookie?.value || tokenCookie;

        if (!token) return null;

        const decoded = jwt.decode(token);
        // prefer 'oid' (Object ID) as stable ID, fallback to 'sub'
        return decoded?.oid || decoded?.sub;
    } catch (e) {
        console.error('Auth: Failed to extract user ID', e);
        return null;
    }
}