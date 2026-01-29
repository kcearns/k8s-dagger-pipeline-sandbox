import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../index";

describe("GET /", () => {
  it("returns welcome message", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Hello from dagger-k8s sample app");
  });
});

describe("GET /health", () => {
  it("returns ok status", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});

describe("GET /health/ready", () => {
  it("returns ready status with uptime", async () => {
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.uptime).toBeTypeOf("number");
  });
});

describe("GET /health/live", () => {
  it("returns alive status", async () => {
    const res = await request(app).get("/health/live");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("alive");
  });
});
