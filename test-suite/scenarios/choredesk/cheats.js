window.ChoreDeskCheats = {
  "choredesk-l1-ticket-priority": [
    { tool: "chrome_fill", params: { selector: "select[aria-label=\"T-104 priority\"]", text: "High" } },
    { tool: "chrome_fill", params: { selector: "select[aria-label=\"T-104 status\"]", text: "In Progress" } },
    { tool: "chrome_click", params: { selector: "button[aria-label=\"save tickets T-104\"]" } }
  ],
  "choredesk-l2-refund-message": [
    { tool: "chrome_click", params: { selector: "a[data-view=\"customers\"]" } },
    { tool: "chrome_click", params: { selector: "a[data-view=\"orders\"]" } },
    { tool: "chrome_click", params: { selector: "a[data-view=\"messages\"]" } },
    { tool: "chrome_fill", params: { selector: "#msgSubject", text: "Refund review ORD-778" } },
    { tool: "chrome_fill", params: { selector: "#msgBody", text: "Noah Kim noah.kim@example.com order ORD-778 total $84.20" } },
    { tool: "chrome_click", params: { selector: "#sendMsg" } }
  ],
  "choredesk-l3-restock-ticket": [
    { tool: "chrome_click", params: { selector: "a[data-view=\"catalog\"]" } },
    { tool: "chrome_click", params: { selector: "a[data-view=\"inventory\"]" } },
    { tool: "chrome_fill", params: { selector: "input[aria-label=\"AST-LAMP reorder quantity\"]", text: "12" } },
    { tool: "chrome_click", params: { selector: "button[aria-label=\"save inventory AST-LAMP\"]" } },
    { tool: "chrome_click", params: { selector: "a[data-view=\"tickets\"]" } },
    { tool: "chrome_fill", params: { selector: "input[aria-label=\"T-205 internal note\"]", text: "reordered 12 AST-LAMP" } },
    { tool: "chrome_click", params: { selector: "button[aria-label=\"save tickets T-205\"]" } }
  ],
  run: {
    "choredesk-l1-ticket-priority": async () => {
      await window.__choredesk.cheatHelpers.route("tickets");
      window.__choredesk.cheatHelpers.set("select[aria-label=\"T-104 priority\"]", "High");
      window.__choredesk.cheatHelpers.set("select[aria-label=\"T-104 status\"]", "In Progress");
      document.querySelector("button[aria-label=\"save tickets T-104\"]").click();
    },
    "choredesk-l2-refund-message": async () => {
      await window.__choredesk.cheatHelpers.route("customers");
      await window.__choredesk.cheatHelpers.route("orders");
      await window.__choredesk.cheatHelpers.route("messages");
      window.__choredesk.cheatHelpers.set("#msgSubject", "Refund review ORD-778");
      window.__choredesk.cheatHelpers.set("#msgBody", "Noah Kim noah.kim@example.com order ORD-778 total $84.20");
      document.querySelector("#sendMsg").click();
    },
    "choredesk-l3-restock-ticket": async () => {
      await window.__choredesk.cheatHelpers.route("catalog");
      await window.__choredesk.cheatHelpers.route("inventory");
      window.__choredesk.cheatHelpers.set("input[aria-label=\"AST-LAMP reorder quantity\"]", "12");
      document.querySelector("button[aria-label=\"save inventory AST-LAMP\"]").click();
      await window.__choredesk.cheatHelpers.route("tickets");
      window.__choredesk.cheatHelpers.set("input[aria-label=\"T-205 internal note\"]", "reordered 12 AST-LAMP");
      document.querySelector("button[aria-label=\"save tickets T-205\"]").click();
    }
  }
};
