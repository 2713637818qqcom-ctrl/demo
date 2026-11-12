// 1. 获取所有动态列表 (GET /api/posts)
export async function onRequestGet(context) {
  const { env } = context;
  try {
    const { results } = await env.DB.prepare(
      "SELECT * FROM posts ORDER BY id DESC"
    ).all();
    return Response.json({ success: true, data: results });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}

// 2. 发布新内容并自动上传文件到 GitHub (POST /api/posts)
export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const formData = await request.formData();
    const type = formData.get("type") || "post"; // photo | music | post | timeline | voice
    const title = (formData.get("title") || "").toString().trim();
    const content = formData.get("content") || "{}";
    const file = formData.get("file");

    // ---------- 权限校验 ----------
    const isVoice = type === "voice";
    const password = request.headers.get("X-Admin-Password");

    if (!isVoice) {
      // 照片 / 音乐 / 随笔 / 时光轴：必须带管理密码
      if (!password || password !== env.ADMIN_PASSWORD) {
        return Response.json({ success: false, error: "管理密码错误" }, { status: 401 });
      }
    } else if (env.VOICE_UPLOAD_KEY) {
      // 如果配置了语音上传口令，则校验；不配置则家人可直接录
      const provided = request.headers.get("X-Voice-Key");
      if (provided !== env.VOICE_UPLOAD_KEY) {
        return Response.json({ success: false, error: "语音口令不正确" }, { status: 401 });
      }
    }

    // ---------- 文件大小限制 ----------
    if (file && file.size > 12 * 1024 * 1024) {
      return Response.json({ success: false, error: "文件超过 12MB，请压缩后再传" }, { status: 413 });
    }

    let mediaUrl = formData.get("external_url") || "";
    let mediaKey = "";

    // ---------- 上传到 GitHub blog-media 仓库 ----------
    if (file && file.size > 0) {
      const ext = (file.name.split(".").pop() || "").toLowerCase();
      const folder = type === "music" ? "music" : type === "voice" ? "voices" : "images";
      mediaKey = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      const base64Content = btoa(binary);

      const ghRes = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${mediaKey}`, {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
          "User-Agent": "Cloudflare-Pages-FamilyBlog",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: `upload ${mediaKey}`,
          content: base64Content
        })
      });

      if (!ghRes.ok) {
        const errData = await ghRes.json().catch(() => ({}));
        throw new Error(`GitHub 上传失败: ${errData.message || ghRes.status}`);
      }

      // jsDelivr CDN 地址（首次访问可能有缓存延迟，刷新即可）
      mediaUrl = `https://cdn.jsdelivr.net/gh/${env.GITHUB_REPO}@main/${mediaKey}`;
    }

    // ---------- 写入 D1 ----------
    const result = await env.DB.prepare(
      "INSERT INTO posts (type, title, content, media_url, media_key) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(type, title || (type === "voice" ? "家人" : ""), content, mediaUrl, mediaKey)
      .run();

    return Response.json({
      success: true,
      id: result.meta ? result.meta.last_row_id : null,
      media_url: mediaUrl,
      type
    });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}

// 3. 删除指定内容及 GitHub 上的对应文件 (DELETE /api/posts?id=1)
export async function onRequestDelete(context) {
  const { request, env } = context;
  const password = request.headers.get("X-Admin-Password");
  if (!password || password !== env.ADMIN_PASSWORD) {
    return Response.json({ success: false, error: "管理密码错误" }, { status: 401 });
  }

  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  try {
    const post = await env.DB.prepare("SELECT media_key FROM posts WHERE id = ?").bind(id).first();

    if (post && post.media_key) {
      const fileUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${post.media_key}`;
      const getRes = await fetch(fileUrl, {
        headers: {
          "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
          "User-Agent": "Cloudflare-Pages-FamilyBlog"
        }
      });
      if (getRes.ok) {
        const fileInfo = await getRes.json();
        await fetch(fileUrl, {
          method: "DELETE",
          headers: {
            "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
            "User-Agent": "Cloudflare-Pages-FamilyBlog",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            message: `delete ${post.media_key}`,
            sha: fileInfo.sha
          })
        });
      }
    }

    await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
