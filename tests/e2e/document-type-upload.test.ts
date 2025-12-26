import { expect, test } from "../fixtures";
import { ChatPage } from "../pages/chat";

test.describe("Upload document type selection", () => {
  test("Shows document type selector in attachments menu", async ({ page }) => {
    const chatPage = new ChatPage(page);
    await chatPage.createNewChat();

    await page.getByTestId("attachments-button").click();

    await expect(page.getByText("Document type")).toBeVisible();
    await expect(page.getByRole("combobox")).toBeVisible();
  });
});


