-- The API reaches a Boat run with its own Boat key now, so no worker answers control requests
-- through the database. A row lived at most 30 seconds; dropping the table loses nothing a running
-- session needs: the next connection asks Boat directly.
DROP TABLE "boat_control_requests";
