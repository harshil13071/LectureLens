import { Router, type IRouter } from "express";
import healthRouter from "./health";
import lectureLensRouter from "./lectureLens";
import studyRoomsRouter from "./studyRooms";

const router: IRouter = Router();

router.use(healthRouter);
router.use(lectureLensRouter);
router.use(studyRoomsRouter);

export default router;
