# Sources and AI assistance disclosure

## Assignment and starter

- [CS409 MP3 README](https://github.com/weibohan07/cs409-mp3/blob/305caa67ca9c93d381a495783c4dfb2f9a3659cd/README.md): endpoint contract, schema, query parameters, validation, two-way references, grading, submission and LLM policy.
- [CS409 MP3 FAQ](https://github.com/weibohan07/cs409-mp3/blob/305caa67ca9c93d381a495783c4dfb2f9a3659cd/FAQ.md): clarified PUT replacement, creation timestamps, status codes, reference consistency, runtime and deployment expectations.
- [Course starter snapshot](https://github.com/weibohan07/cs409-mp3/tree/305caa67ca9c93d381a495783c4dfb2f9a3659cd): existing Express/Mongoose project, dependency configuration and course-provided `submit.js`. The course's `AUTOGRADER_URL` is retained.

The implementation preserves the original assignment README and FAQ as the authoritative specification. `IMPLEMENTATION.md` is an implementation/setup guide, not a replacement course policy.

## Technical references

- [Mongoose transactions](https://mongoosejs.com/docs/transactions.html): transaction/session handling for atomic cross-document updates.
- [Mongoose validation](https://mongoosejs.com/docs/validation.html): schema validation and unique-index behavior.
- [Mongoose timestamps](https://mongoosejs.com/docs/timestamps.html): server-managed creation times and update semantics; this implementation explicitly preserves `dateCreated`.
- [Deploy a Node Express app on Render](https://render.com/docs/deploy-node-express-app): web-service build/start configuration and deployment setup.
- [Render Node version configuration](https://render.com/docs/node-version): selecting Node 24 through the environment and project configuration.
- [mongodb-memory-server README](https://github.com/typegoose/mongodb-memory-server): real temporary MongoDB instances, replica-set testing, and binary download behavior. The installed package README was also consulted.

## AI assistance

OpenAI ChatGPT assisted in interpreting the assignment and FAQ, designing the User/Task consistency rules, generating and reviewing implementation code, writing automated checks, and preparing setup/deployment documentation. The student requested a complete starting implementation and intends to make further personal changes.

This disclosure describes the actual assistance in this development session. It does **not** claim that the official autograder was run, that a deployed submission earned 100, or that this file is a complete conversation transcript.

## Required student submission work

The course's LLM policy requires the **actual chatlogs alongside the source code** and answers to the LLM-experience survey in the grading form. Export and retain the real conversation used for this work, including relevant later coding sessions. This source list is not a substitute for that log; no reconstructed or invented transcript is included here.

Add any additional code sources, documentation, tutorials, or later AI assistance you reference while making your own modifications. Review the generated code and rerun the tests and official deployed self-check before the formal submission.
