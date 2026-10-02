const express = require('express');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Supabase Client using backend environment variables
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// 1. Start OAuth Flow
app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/youtube.upload'],
    prompt: 'consent' // Forces Google to issue a refresh_token
  });
  res.redirect(url);
});

// 2. OAuth Callback: Exchange code for tokens and save to Supabase
app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send("Authorization code missing.");
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    
    // Google only sends refresh_token on the very first consent or when prompt='consent' is used
    if (tokens.refresh_token) {
      // For testing, we'll store it under a default client email or generic key until multi-client mapping is fully built out
      const clientEmail = "comshell.master.zm@gmail.com"; 

      const { error } = await supabase
        .from('youtube_tokens')
        .upsert({ email: clientEmail, refresh_token: tokens.refresh_token, updated_at: new Date() }, { onConflict: 'email' });

      if (error) {
        console.error("Supabase save error:", error);
      } else {
        console.log("Refresh token successfully saved to Supabase!");
      }
    }

    res.redirect('https://comshell.github.io/dashboard.html?linked=success');
  } catch (error) {
    console.error("Error exchanging code for tokens:", error);
    res.redirect('https://comshell.github.io/dashboard.html?error=token_failed');
  }
});

// 3. Initiate Resumable Upload (Pulls real token from Supabase)
app.post('/api/initiate-upload', async (req, res) => {
  try {
    const clientEmail = "comshell.master.zm@gmail.com";

    // Fetch the real refresh token from Supabase
    const { data, error } = await supabase
      .from('youtube_tokens')
      .select('refresh_token')
      .eq('email', clientEmail)
      .single();

    if (error || !data || !data.refresh_token) {
      return res.status(401).json({ error: "Mom's connection expired, she needs to tap 'Relink YouTube' on her dashboard." });
    }

    // Set credentials with the retrieved refresh token
    oauth2Client.setCredentials({ refresh_token: data.refresh_token });

    const youtube = google.youtube({
      version: 'v3',
      auth: oauth2Client
    });

    const { title, description } = req.body;

    // Request a Resumable Upload Session URL from YouTube
    const response = await youtube.videos.insert({
      part: 'snippet,status',
      requestBody: {
        snippet: {
          title: title || 'Default Upload Title',
          description: description || 'Uploaded via Secure Client Pipeline',
          categoryId: '22'
        },
        status: {
          privacyStatus: 'private' // Safe default for testing
        }
      },
      media: {
        body: '' // Initiating session only
      }
    }, {
      // Tell googleapis to return the resumable upload session header
      headers: {
        'X-Upload-Content-Length': req.headers['x-upload-content-length'] || 0,
        'X-Upload-Content-Type': req.headers['x-upload-content-type'] || 'video/*'
      }
    });

    // Send the direct upload URL back to the frontend browser
    const uploadUrl = response.headers.location;
    res.json({ uploadUrl });

  } catch (err) {
    console.error("Error initiating upload session:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend server running on port ${PORT}`));
