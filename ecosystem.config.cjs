module.exports = {
  apps: [
    {
      name: "mahoraga-api",
      script: "./agent-v1.mjs",
      cwd: "/home/brock/clawd/projects/mahoraga",
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "development",
        ALPACA_API_KEY: "PKKV7ANWA3WPWSPKX54U6K3WRY",
        ALPACA_API_SECRET: "H9Wo6GqTxkXUBY8nJf7cWvkwY2LuhM6Hk4iyuDffXDfJ",
        ALPACA_PAPER: "true"
      }
    },
    {
      name: "mahoraga-dashboard",
      script: "npm",
      args: "run dev",
      cwd: "/home/brock/clawd/projects/mahoraga/dashboard",
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "development",
        PORT: "5175",
        HOST: "0.0.0.0"
      }
    }
  ]
};
