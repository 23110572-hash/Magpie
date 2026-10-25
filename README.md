# Magpie — Ask in your own words. Get research-ready data.

Magpie is an AI-powered data research tool that turns a plain-language request into a structured dataset with links back to its sources. Describe what you are looking for, choose a market and a search depth, and Magpie plans and runs a suitable research workflow.

You can write naturally—even with spelling mistakes, informal wording, or Hinglish. You do not need to configure a separate scraper for every kind of search.

> **Example**
>
> **You ask:** `mujhe chandigarh mein web developer chahiye`
>
> **Magpie understands:** Web developers in Chandigarh, India
>
> **You get:** A structured list of results, with available contact details and links to the sources behind them.

The numbers returned depend on the request and sources available; the example above illustrates the workflow rather than promising a fixed result count.

## Try Magpie

- **Live app:** https://magpie-lake-iota.vercel.app
- **Backend health check:** https://magpie-9pln.onrender.com
- **Source code:** https://github.com/23110572-hash/Magpie

The backend currently uses a free hosting plan and may sleep when idle. The first request after a quiet period can take about a minute while the service wakes up.

## Built with Kiro

Magpie is a project built with help from **Kiro**. I used Kiro during development to research approaches, explore implementation options, work through problems, and iterate on an AI-powered application. The project is also an opportunity to share a practical example of what can be built with AI-assisted development and to contribute to the open-source developer community.

## What can you use Magpie for?

Magpie's workflow can adapt to different research requests, including:

- Finding people or professionals to contact
- Discovering job openings
- Researching local businesses and agencies
- Finding companies, startups, and potential sponsors
- Exploring events, news, and market information

Rather than relying on a fixed list of cities, job titles, or keywords, Magpie uses an AI planner to interpret each request and decide what information to look for, which sources to check, and which fields will be useful in the final dataset.

## Features

- **Plain-language input:** Describe the result you need in your own words, including informal language and Hinglish.
- **Market selection:** Choose India, the United States, or the European Union.
- **Three research depths:** Use Fast, Balanced, or Deep mode depending on how broad a search you need.
- **Live workflow progress:** Follow the search as Magpie interprets the request, reviews pages, checks relevance, merges duplicates, looks for public contact details, and saves results. A running search can be cancelled.
- **Visible interpretation:** Review how Magpie understood your request and choose an alternative interpretation when the intent needs correcting.
- **Flexible datasets:** Magpie selects relevant columns for the request. Explore results in table or card view, search and filter them, and export data as CSV, JSON, or PDF.
- **Source traceability:** Review each result's source URL, collection time, match reason, other places it appeared, and saved source snapshot.
- **Careful contact handling:** Email addresses and phone numbers are retained only when they are found in the source, rather than being guessed by the model.
- **Saved research history:** Reopen, rerun, or delete previous workflows and datasets.
- **Lead and outreach workflow:** Turn selected records into leads and generate a personalised outreach email draft.
- **Private user workspaces:** Signed-in users can access their own workflows, datasets, and leads.

## How it works

Each request goes through the same broad workflow. The AI helps plan and interpret the research; application logic handles validation, storage, and traceability.

1. **Understand the request** — Interpret the prompt, identify the requested result type and location, choose useful dataset fields, and prepare search queries.
2. **Find sources** — Search relevant discovery tools and structured sources for the selected market.
3. **Read useful pages** — Decide which results are worth inspecting and extract relevant entries from suitable pages or directories.
4. **Check relevance** — Compare each candidate against the original request and record a relevance score and explanation.
5. **Merge duplicates** — Combine repeated references to the same person, company, or business where matching information is available.
6. **Look for public contacts** — Check relevant websites and contact pages for published email addresses and phone numbers.
7. **Save the dataset** — Store the result with source information and calculate the available contact coverage.

### Research depth

The modes control how much discovery and review Magpie attempts. Search sizes and timings are approximate and can vary with the request and source availability.

| Setting | Fast | Balanced | Deep |
| --- | ---: | ---: | ---: |
| Credits per search | 1 | 2 | 4 |
| Google web searches | 2 | 4 | 8 |
| Results per Google search | 10 | 10 | 20 (up to 2 pages) |
| Tavily searches | 1 | 2 | 4 |
| Google Maps searches | 1 | 2 | 4 × 2 pages |
| Cities covered for country-wide requests | 2 | 4 | 8 |
| Web results reviewed by AI | 30 | 60 | 160 |
| List pages read | 3 | 8 | 20, plus the next page of the best lists |
| GitHub profiles | 15 | 30 | 90 |
| Adzuna job results | 40 | 50 | 100 |
| Candidates checked for relevance | 120 | 250 | 600 |
| Websites checked for contacts | 12 | 30 | 80 |
| Typical expected time | ~40 seconds | ~1.5 minutes | ~3–4 minutes |

## Data sources and responsible collection

Depending on the request, Magpie can use sources and integrations such as Google web search, Google Maps, Google News, Tavily, GitHub, Adzuna, Greenhouse, Lever, Ashby, Remotive, Arbeitnow, Hacker News, and Wikipedia.

Magpie is designed around a few important principles:

- **Do not invent data.** Contact details and URLs must be present in the source to be retained; placeholder values are removed.
- **Respect access rules.** The workflow is intended to use permitted public pages and official APIs, respects `robots.txt`, and avoids fetching sites whose terms prohibit scraping.
- **Keep sources attached to results.** Source information is stored with the record so users can check where it came from.
- **Handle failures gracefully.** If one source or page fails, the workflow can continue with other available results and report the issue.

Please use Magpie responsibly and check the relevant source terms and applicable laws when collecting or using data.

## Technology stack

| Component | Technologies | Purpose |
| --- | --- | --- |
| Frontend | React, TypeScript, Tailwind CSS | Prompt input, progress display, datasets, leads, history, credits, and settings |
| Backend | Python, FastAPI, `asyncio` | Runs the research workflow and streams progress to the frontend |
| AI model | Meta Llama 3.3 70B via OpenRouter | Planning, page selection, extraction, relevance checks, and outreach drafts |
| Web discovery | Serper, Tavily | Finds pages, directories, profiles, and businesses |
| Structured sources | GitHub, Adzuna, Greenhouse, Lever, Ashby, Remotive, Arbeitnow, Hacker News, Wikipedia | Supplies developer, job, company, and topic information |
| Database | Neon serverless PostgreSQL | Stores users, workflows, datasets, records, source snapshots, and leads |

At a high level, the data model connects a user to workflow runs, datasets, individual source-backed records, and leads created from selected records.

## Example end-to-end checks

The following examples were tested against live sources using the India market in Balanced mode. Results are examples from those runs, not guaranteed counts for future searches.

| Prompt | Interpreted request | Records returned | With email | With phone |
| --- | --- | ---: | ---: | ---: |
| `i need devloper in chandigarh` | Web developers in Chandigarh, India | 34 | 16 | 1 |
| `i want a graphic desinger search all designer from india` | Graphic designers in India | 35 | 0 | 0 |
| `mujhe chandigarh mein web developer chahiye` | Web developers in Chandigarh, India | 38 | 9 | 1 |
| `react js jobs in bangalore for freshers` | React JS jobs for freshers in Bangalore, India | 25 | 0 | 0 |
| `digital marketing agencies in mumbai with emails` | Digital marketing agencies in Mumbai, India | 79 | 29 | 36 |
| `sponsors for college tech fest in delhi` | Sponsors for a college tech fest in Delhi, India | 20 | 0 | 2 |
| `top fintech startups in india` | Fintech startups in India | 74 | 16 | 0 |

In these runs, all seven prompts were interpreted with the intended type of result and location, including the misspelled and Hinglish prompts. Every saved row included a source link and raw snapshot.

The project has also been checked for core flows including authentication, user-level data separation, CSV and JSON export, progress streaming, lead creation, AI-drafted outreach, and account-data deletion.

## Contributing

Magpie is intended to be useful to developers who want to explore, improve, and extend AI-driven data research workflows. Contributions that improve usability, source handling, validation, traceability, reliability, or documentation are especially welcome.

A useful contribution process is:

1. Review the existing implementation before changing a workflow.
2. Keep results traceable and avoid adding guessed contact details.
3. Test changes against a variety of prompts, including misspellings and mixed-language input.
4. Describe what changed and include reproduction steps or test results in your pull request.

Please open an issue to discuss a larger change before investing in a substantial implementation.

## Running locally

The application uses separate frontend and backend components and relies on external services. Check the repository's current source and configuration files for the exact install commands, required environment variables, and provider credentials; those setup details are not included in the project notes used to write this README.

## License

This README describes Magpie as an intended open-source project, but the supplied project notes did not specify a license. Add a `LICENSE` file to the repository before others rely on permissions to use, modify, or redistribute the code.
