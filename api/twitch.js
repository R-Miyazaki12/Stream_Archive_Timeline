// Vercel Serverless Function to act as a secure proxy to the Twitch API.

// --- App Access Token Cache ---
// We cache the token to avoid requesting a new one for every single API call.
let token = {
    access_token: null,
    expires_at: null,
};

// --- Main Handler ---
module.exports = async (req, res) => {
    // Allow CORS for all origins
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight OPTIONS request for CORS
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Only allow POST requests
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ message: 'Method Not Allowed' });
    }

    const { endpoint } = req.body;
    if (!endpoint) {
        return res.status(400).json({ message: 'API endpoint is required in the request body.' });
    }

    try {
        const accessToken = await getAppAccessToken();
        if (!accessToken) {
            return res.status(500).json({ message: 'Failed to retrieve App Access Token.' });
        }

        const twitchApiUrl = `https://api.twitch.tv/helix/${endpoint}`;
        const clientId = process.env.TWITCH_CLIENT_ID;

        const apiResponse = await fetch(twitchApiUrl, {
            headers: {
                'Client-ID': clientId,
                'Authorization': `Bearer ${accessToken}`,
            },
        });

        if (!apiResponse.ok) {
            const errorData = await apiResponse.json().catch(() => ({}));
            return res.status(apiResponse.status).json({ 
                message: `Twitch API request failed: ${apiResponse.statusText}`,
                details: errorData
            });
        }

        const data = await apiResponse.json();
        return res.status(200).json(data);

    } catch (error) {
        console.error('Internal Server Error:', error);
        return res.status(500).json({ message: 'Internal Server Error.', details: error.message });
    }
};

// --- Helper Functions ---

/**
 * Gets a valid Twitch App Access Token, either from cache or by fetching a new one.
 */
async function getAppAccessToken() {
    // If we have a valid token in cache, return it
    if (token.access_token && token.expires_at > Date.now()) {
        return token.access_token;
    }

    // Otherwise, fetch a new one
    const clientId = process.env.TWITCH_CLIENT_ID;
    const clientSecret = process.env.TWITCH_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        console.error('TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET is not set in environment variables.');
        return null;
    }

    const tokenUrl = `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`;

    try {
        const response = await fetch(tokenUrl, { method: 'POST' });
        if (!response.ok) {
            throw new Error(`Failed to get token: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();

        // Cache the new token and set its expiration time (with a 60-second buffer)
        token.access_token = data.access_token;
        token.expires_at = Date.now() + (data.expires_in * 1000) - 60000;

        return token.access_token;
    } catch (error) {
        console.error('Error fetching App Access Token:', error);
        // Clear the expired/invalid token
        token.access_token = null;
        token.expires_at = null;
        return null;
    }
}
