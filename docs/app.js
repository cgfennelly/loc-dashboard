const COLORS = {
  human: "#3dbb8b",
  agent: "#5b8def",
  unknown: "#c4a35a",
};

const FALLBACK_COLORS = ["#9b7bdb", "#e07a5f", "#4ecdc4", "#f2cc8f"];

async function main() {
  const errorEl = document.getElementById("error");
  try {
    const data = await loadData();
    renderMeta(data);
    renderStats(data);
    renderLegend(data);
    renderCharts(data);
    renderRepoTable(data);
  } catch (err) {
    errorEl.hidden = false;
    errorEl.textContent = `Failed to load data: ${err.message}`;
    document.getElementById("meta").textContent = "No data yet";
  }
}

async function loadData() {
  const paths = ["./data/timeseries.min.json", "./data/timeseries.json"];
  for (const path of paths) {
    const res = await fetch(path, { cache: "no-store" });
    if (res.ok) return res.json();
  }
  throw new Error("timeseries data not found");
}

function renderMeta(data) {
  const generated = data.generatedAt
    ? new Date(data.generatedAt).toLocaleString("en-GB", {
        timeZone: "Europe/London",
        dateStyle: "medium",
        timeStyle: "short",
      }) + " Europe/London"
    : "never";
  const repos = data.summary?.reposScanned ?? "—";
  document.getElementById("meta").innerHTML = `
    <div>Updated ${generated}</div>
    <div>${repos} repos · ${fmt(data.summary?.totalAdditions || 0)} lines</div>
  `;
}

function renderStats(data) {
  const by = data.summary?.byCommitter || {};
  const cards = [
    {
      label: "Total additions",
      value: data.summary?.totalAdditions || 0,
      className: "",
    },
    {
      label: data.committers?.human || "You",
      value: by.human?.additions || 0,
      className: "human",
    },
    {
      label: data.committers?.agent || "Agent",
      value: by.agent?.additions || 0,
      className: "agent",
    },
  ];
  if (by.unknown?.additions) {
    cards.push({
      label: data.committers?.unknown || "Other",
      value: by.unknown.additions,
      className: "other",
    });
  }
  document.getElementById("stats").innerHTML = cards
    .map(
      (c) => `
      <article class="stat">
        <div class="label">${escapeHtml(c.label)}</div>
        <div class="value ${c.className}">${fmt(c.value)}</div>
      </article>`,
    )
    .join("");
}

function renderLegend(data) {
  const ids = seriesIds(data);
  document.getElementById("legend").innerHTML = ids
    .map((id) => {
      const label = data.committers?.[id] || id;
      const cls = id === "human" || id === "agent" || id === "unknown" ? id : "other";
      return `<span><i class="swatch ${cls}" style="background:${colorFor(id)}"></i>${escapeHtml(label)}</span>`;
    })
    .join("");
}

function renderCharts(data) {
  const ids = seriesIds(data);
  const cumulative = data.cumulative || [];
  const daily = data.daily || [];

  const cumDatasets = ids.map((id) => ({
    label: data.committers?.[id] || id,
    data: cumulative.map((row) => row.byCommitter?.[id] || 0),
    borderColor: colorFor(id),
    backgroundColor: hexAlpha(colorFor(id), 0.18),
    fill: true,
    tension: 0.25,
    pointRadius: 0,
    borderWidth: 2,
  }));

  new Chart(document.getElementById("cumulativeChart"), {
    type: "line",
    data: {
      labels: cumulative.map((row) => row.date),
      datasets: cumDatasets,
    },
    options: chartOptions("Cumulative filtered additions"),
  });

  const dailyDatasets = ids.map((id) => ({
    label: data.committers?.[id] || id,
    data: daily.map((row) => row.byCommitter?.[id]?.additions || 0),
    backgroundColor: hexAlpha(colorFor(id), 0.85),
    borderWidth: 0,
    stack: "day",
  }));

  new Chart(document.getElementById("dailyChart"), {
    type: "bar",
    data: {
      labels: daily.map((row) => row.date),
      datasets: dailyDatasets,
    },
    options: {
      ...chartOptions("Daily filtered additions"),
      scales: {
        x: {
          stacked: true,
          ticks: { color: "#93a0b0", maxTicksLimit: 10 },
          grid: { color: "rgba(42,52,65,0.5)" },
        },
        y: {
          stacked: true,
          ticks: { color: "#93a0b0" },
          grid: { color: "rgba(42,52,65,0.5)" },
        },
      },
    },
  });
}

function renderRepoTable(data) {
  const byRepo = data.summary?.byRepo || {};
  const rows = Object.entries(byRepo)
    .map(([repo, committers]) => {
      const human = committers.human?.additions || 0;
      const agent = committers.agent?.additions || 0;
      const other = Object.entries(committers)
        .filter(([id]) => id !== "human" && id !== "agent")
        .reduce((sum, [, b]) => sum + (b.additions || 0), 0);
      return { repo, human, agent, other, total: human + agent + other };
    })
    .sort((a, b) => b.total - a.total);

  document.getElementById("repoRows").innerHTML = rows
    .map(
      (r) => `
      <tr>
        <td>${escapeHtml(r.repo)}</td>
        <td class="num">${fmt(r.human)}</td>
        <td class="num">${fmt(r.agent)}</td>
        <td class="num">${fmt(r.other)}</td>
        <td class="num">${fmt(r.total)}</td>
      </tr>`,
    )
    .join("");
}

function seriesIds(data) {
  const ids = new Set(Object.keys(data.committers || {}));
  for (const row of data.cumulative || []) {
    for (const id of Object.keys(row.byCommitter || {})) ids.add(id);
  }
  const preferred = ["human", "agent", "unknown"];
  const rest = [...ids].filter((id) => !preferred.includes(id)).sort();
  return [...preferred.filter((id) => ids.has(id)), ...rest];
}

function chartOptions(title) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      title: { display: false, text: title },
      tooltip: {
        callbacks: {
          label: (ctx) => `${ctx.dataset.label}: ${fmt(ctx.parsed.y)}`,
        },
      },
    },
    scales: {
      x: {
        ticks: { color: "#93a0b0", maxTicksLimit: 10 },
        grid: { color: "rgba(42,52,65,0.5)" },
      },
      y: {
        ticks: { color: "#93a0b0" },
        grid: { color: "rgba(42,52,65,0.5)" },
      },
    },
  };
}

function colorFor(id) {
  if (COLORS[id]) return COLORS[id];
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
}

function hexAlpha(hex, alpha) {
  const n = hex.replace("#", "");
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function fmt(n) {
  return Number(n || 0).toLocaleString("en-GB");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

main();
