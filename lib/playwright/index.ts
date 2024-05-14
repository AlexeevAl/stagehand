import OpenAI from "openai";
import {
  type Page,
  type Browser,
  type BrowserContext,
  test as base,
  chromium,
} from "@playwright/test";
import { expect } from "@playwright/test";
import {
  readActions,
  readObservations,
  writeObservations,
  writeActions,
  getCacheKey,
  evictCache,
} from "../cache";

require("dotenv").config({ path: ".env" });

export class Stagehand {
  private openai: OpenAI;
  private observations: { [key: string]: { result: string; testKey: string } };
  private actions: { [key: string]: { result: string; testKey: string } };
  testKey: string;

  constructor(
    public page: Page,
    public browser: Browser,
    public context: BrowserContext
  ) {
    this.openai = new OpenAI();

    if (browser && context) {
      const defaultContext = context;
      this.setPage(defaultContext.pages()[0]);
    }

    this.observations = readObservations();
    this.actions = readActions();
  }

  async observe(observation: string): Promise<string> {
    const key = getCacheKey(observation);
    if (this.observations[key]) {
      console.log("cache hit!");
      console.log(`using ${this.observations[key]}`);

      expect(this.page.locator(this.observations[key].result)).toBeAttached();

      return key;
    }

    const shot = await this.page.screenshot({
      fullPage: true,
    });

    const response = await this.openai.chat.completions.create({
      model: "gpt-4-vision-preview",
      messages: [
        {
          role: "system",
          content: `You are helping a user navigate a webpage, given a screenshot. Verify that the users request is possible, and if so, provide a simple description of the target element that would satisfy the request.
          respond ONLY with the element description

    `,
        },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${shot.toString("base64")}`,
              },
            },
            {
              type: "text",
              text: `
                user request: ${observation}
                 `,
            },
          ],
        },
      ],
    });

    if (!response.choices[0].message.content) {
      throw new Error("no response when observing");
    }

    const fullBody = await this.page.evaluate(() => document.body.outerHTML);
    const quarterLength = Math.floor(fullBody.length / 4);
    const bodies = [
      fullBody.substring(0, quarterLength),
      fullBody.substring(quarterLength, quarterLength * 2),
      fullBody.substring(quarterLength * 2, quarterLength * 3),
      fullBody.substring(quarterLength * 3),
    ];

    for (const body of bodies) {
      const selectorResponse = await this.openai.chat.completions.create({
        model: "gpt-4-turbo-preview",
        messages: [
          {
            role: "system",
            content: `You are helping the user automate the browser by finding a playwright locator string. You will be given a description of the element to find, and the DOM.


            return only the string to pass to playwright, no markdown
            if the element is not found, return NONE
                  
                  `,
          },
          {
            role: "user",
            content: `
                    description: ${response.choices[0].message.content}
                    DOM: ${body}
                    `,
          },
        ],

        temperature: 0.1,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0,
      });

      if (!selectorResponse.choices[0].message.content) {
        throw new Error("no response when finding a selector");
      }

      if (selectorResponse.choices[0].message.content === "NONE") {
        continue;
      }

      expect(
        this.page.locator(selectorResponse.choices[0].message.content)
      ).toBeAttached();

      console.log(
        this.page.locator(selectorResponse.choices[0].message.content)
      );
      const key = await this.cacheObservation(
        observation,
        selectorResponse.choices[0].message.content
      );

      return key;
    }

    throw new Error("fail");
  }
  setTestKey(key: string) {
    this.testKey = key;
  }

  async cacheObservation(observation: string, result: string): Promise<string> {
    let cache = readObservations();

    const key = getCacheKey(observation);

    cache[key] = { result, testKey: this.testKey };
    this.observations[key] = { result, testKey: this.testKey };

    writeObservations(cache);
    return key;
  }

  async cacheAction(action: string, result: string): Promise<string> {
    let cache = readActions();

    const key = getCacheKey(action);

    cache[key] = { result, testKey: this.testKey };
    this.actions[key] = { result, testKey: this.testKey };

    writeActions(cache);
    return key;
  }

  async act({
    observation,
    action,
    data,
  }: {
    observation?: string;
    action: string;
    data?: object;
  }): Promise<void> {
    console.log("taking action: ", action);
    const key = getCacheKey(action);
    let cachedAction = this.actions[key];
    if (cachedAction) {
      console.log(`cache hit for action: ${action}`);
      console.log(cachedAction);
      const res = JSON.parse(cachedAction.result);
      console.log(res);
      for (const command of res) {
        const locatorStr = command["locator"];
        const method = command["method"];
        const args = command["args"];

        console.log(
          `Cached action ${method} on ${locatorStr} with args ${args}`
        );
        const locator = await this.page.locator(locatorStr).first();
        await locator[method](...args);
      }
      await this.page.waitForTimeout(2000); //waitForNavigation and waitForLoadState do not work in this case

      return;
    }
    const area = observation
      ? await this.page
          .locator(this.observations[observation].result)
          .innerHTML()
      : await this.page.locator("body").innerHTML();

    const response = await this.openai.chat.completions.create({
      model: "gpt-4-turbo-preview",
      messages: [
        {
          role: "system",
          content:
            "You are helping the user automate browser by finding one or more actions to take.\n\nyou will be given a DOM element, an overall goal, and data to use when taking actions.\n\nuse selectors that are least likely to change\n\nfor each action required to complete the goal,  follow this format in raw JSON, no markdown\n\n[{\n method: string (the required playwright function to call)\n locator: string (the locator to find the element to act on),\nargs: Array<string | number> (the required arguments)\n}]\n\n\n\n",
        },
        {
          role: "user",
          content: `
            action: ${action},
            DOM: ${area}
            data: ${JSON.stringify(data)}`,
        },
      ],

      temperature: 0.1,
      max_tokens: 256,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    });

    if (!response.choices[0].message.content) {
      throw new Error("no response from action model");
    }

    const res = JSON.parse(response.choices[0].message.content);
    for (const command of res) {
      const locatorStr = command["locator"];
      const method = command["method"];
      const args = command["args"];

      console.log(`taking action ${method} on ${locatorStr} with args ${args}`);
      const locator = await this.page.locator(locatorStr).first();
      await locator[method](...args);
    }

    this.cacheAction(action, response.choices[0].message.content);

    await this.page.waitForTimeout(2000); //waitForNavigation and waitForLoadState do not work in this case

    console.log("done acting");
  }
  setPage(page: Page) {
    this.page = page;
  }
  setContext(context: BrowserContext) {
    this.context = context;
  }
}

type Fixture = {
  stagePage: Stagehand;
};
