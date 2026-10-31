---
description: "The terms for using SHAPI's hosted GitHub App and web app."
---

# Terms of service

::: warning Draft
These terms apply to SHAPI's early access, which is open to everyone now. They have not been reviewed by a lawyer yet and may change before general availability; changes are posted on this page. Last updated October 30, 2026.
:::

These terms are an agreement between you and SHAPI. SHAPI is operated by its founder and is not yet incorporated; "SHAPI", "we" and "us" mean the SHAPI project and its operator. If you use SHAPI for an organization, you accept these terms for that organization and confirm you're allowed to.

## 1. The service

SHAPI finds code that breaks when a third-party API changes, and proposes fixes. It has three parts:

- **The hosted service:** the SHAPI GitHub App and web app. These terms apply to it.
- **`shapi-cli`:** licensed under the [Apache License 2.0](https://unpkg.com/shapi-cli/LICENSE) (the `LICENSE` file in the npm package). That license governs your use of the CLI; these terms don't.
- **The advisory database:** open data under [CC BY 4.0](https://github.com/SriVarshini09/shapi-advisories), governed by that license.

The GitHub App is in early access. Features may change, and we may limit who can install it.

## 2. Your account

You sign in and install SHAPI through GitHub, so your GitHub account's security is your responsibility. You must be at least 16 and able to enter a binding contract.

## 3. Your code and data

You keep all rights to your code and data. You give SHAPI a limited permission to access, copy, process and store them only as needed to run the service for you: to scan your repositories, run contract tests, and open checks, issues and pull requests. That includes sending data to the providers listed on the [subprocessors](/legal/subprocessors) page. How data is handled is described in the [privacy policy](/legal/privacy) and on the [security](/security) page.

SHAPI doesn't use your code to train AI models. It sends code to an AI provider only when you turn that on, and only under terms that don't allow training on it.

## 4. Fix pull requests are suggestions

SHAPI verifies a fix with a contract test before it opens a pull request, but no test can prove a change is correct for your system. **You decide whether to merge.** Review every pull request as you would one from a colleague. You're responsible for what you merge and deploy.

Findings and advisories describe third-party APIs that SHAPI doesn't control. They may be incomplete, late or wrong.

## 5. Acceptable use

Don't use SHAPI to:

- break the law, or infringe anyone's rights;
- access repositories you're not allowed to access;
- interfere with the service, test its security without following the [vulnerability reporting](/security#reporting-a-vulnerability) process, or try to escape its sandboxes;
- run code in SHAPI's sandboxes for any purpose other than testing your repository, for example mining cryptocurrency or attacking other systems;
- resell the hosted service without our written permission.

We may suspend an account that does these things, and we'll tell you why unless the law prevents it.

## 6. Plans and payment

- **Free:** public repositories, and private repositories with up to 3 active committers.
- **Active committers:** anyone who committed to one of your private repositories in the last 90 days, counted once however many of them they commit to. Bots aren't counted. SHAPI counts them each time it scans a private repository.
- **Paid:** each active committer beyond the first 3 is a seat, charged monthly at the price shown in the web app before you pay. Payments are handled by Stripe.
- **No surprise charges:** new committers don't raise your bill on their own. While more people commit than your plan covers, SHAPI stops scanning and fixing your private repositories (public ones carry on), and the web app asks before you pay for more seats. When people stop committing, the seats go down automatically within a day.
- **Cancelling:** cancel any time under *Manage billing*. You keep the paid plan until the end of the period you've paid for. Uninstalling the GitHub App cancels the subscription at once, without a refund for the current period.
- **Refunds:** paid periods aren't refunded, except where the law requires.
- **Price changes:** we'll give at least 30 days' notice in the web app and to your Stripe billing email before a new price applies to you.

## 7. Ending the agreement

You can stop at any time by uninstalling the GitHub App; SHAPI then deletes your data as described in the [privacy policy](/legal/privacy). We can end the service for you with 30 days' notice, or at once if you seriously break these terms. If we shut the hosted service down, we'll give at least 30 days' notice. The CLI and the advisories stay available under their open licenses.

## 8. No warranty

SHAPI is provided **"as is"**, without warranties of any kind, including fitness for a particular purpose and uninterrupted or error-free operation, to the extent the law allows.

## 9. Limitation of liability

To the extent the law allows, SHAPI isn't liable for indirect, incidental, special or consequential damages, or for lost profits, revenue or data. SHAPI's total liability for any claim related to the service is limited to the greater of the amount you paid SHAPI in the 12 months before the claim, or US$100.

## 10. Changes to these terms

We'll post changes on this page, with the date at the top. For a significant change, we'll give at least 30 days' notice before it applies to you. Continuing to use SHAPI after that means you accept the new terms.

## 11. Governing law

These terms are governed by the laws of the State of Delaware, USA, without regard to its conflict-of-law rules. Disputes go to the state or federal courts in Delaware.

## 12. Contact

Email [sri@shapi.dev](mailto:sri@shapi.dev). For a public question or a bug, you can also [open an issue](https://github.com/SriVarshini09/shapi-advisories/issues).
