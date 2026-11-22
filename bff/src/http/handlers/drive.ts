// `GET`/`POST /api/drive/folders`: the Drive folder picker. The session is checked first.

import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { createDriveFolder, listDriveFolders } from "../../application/driveFolders.ts";
import { Api } from "../api.ts";
import { accessToken, bodyBytes, queryParam } from "../request.ts";

export const DriveLive = HttpApiBuilder.group(Api, "drive", (handlers) =>
  handlers
    .handle("listFolders", () =>
      Effect.gen(function* () {
        const token = yield* accessToken;
        return yield* listDriveFolders(token, yield* queryParam("parentId"));
      }),
    )
    .handleRaw("createFolder", () =>
      Effect.gen(function* () {
        const token = yield* accessToken;
        return yield* createDriveFolder(token, yield* bodyBytes);
      }),
    ),
);
