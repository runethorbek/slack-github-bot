export default {
  async fetch(request) {
    try {
      // Slack slash commands sendes som application/x-www-form-urlencoded
      const formData = await request.formData();

      const text = formData.get("text") ?? "";
      const responseUrl = formData.get("response_url") ?? "";
      const channelId = formData.get("channel_id") ?? "";
      const userId = formData.get("user_id") ?? "";

      const githubResponse = await fetch(
        `https://api.github.com/repos/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/dispatches`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({
            event_type: "slack_message",
            client_payload: {
              text,
              response_url: responseUrl,
              channel_id: channelId,
              user_id: userId,
            },
          }),
        }
      );

      if (!githubResponse.ok) {
        const errorText = await githubResponse.text();

        console.error(
          `GitHub returned ${githubResponse.status}: ${errorText}`
        );

        return new Response("Kunne ikke starte GitHub Action", {
          status: 500,
        });
      }

      return new Response("Modtaget", {
        status: 200,
      });
    } catch (error) {
      console.error(error);

      return new Response("Internal server error", {
        status: 500,
      });
    }
  },
};
