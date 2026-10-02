const express = require('express');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/youtube.upload'],
    prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send("Authorization code missing.");
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    
    if (tokens.refresh_token) {
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

app.post('/api/initiate-upload', async (req, res) => {
  try {
    const clientEmail = "comshell.master.zm@gmail.com";

    const { data, error } = await supabase
      .from('youtube_tokens')
      .select('refresh_token')
      .eq('email', clientEmail)
      .single();

    if (error || !data || !data.refresh_token) {
      return res.status(401).json({ error: "Connection expired, please tap 'Link YouTube Account' on your dashboard." });
    }

    oauth2Client.setCredentials({ refresh_token: data.refresh_token });

    const youtube = google.youtube({
      version: 'v3',
      auth: oauth2Client
    });

    const { title, description, fileSize, fileType } = req.body;
    const actualFileType = fileType || 'video/*';

    const response = await youtube.videos.insert({
      part: 'snippet,status',
      requestBody: {
        snippet: {
          title: title || 'Verification Upload',
          description: description || 'Pending verification video submission.',
          categoryId: '22'
        },
        status: {
          privacyStatus: 'private'
        }
      },
      media: {
        body: ''
      }
    }, {
      headers: {
        'X-Upload-Content-Length': fileSize || 0,
        'X-Upload-Content-Type': actualFileType
      }
    });

    const uploadUrl = response.headers.location;
    res.json({ uploadUrl });

  } catch (err) {
    console.error("Error initiating upload session:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend server running on port ${PORT}`));
