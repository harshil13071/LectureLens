import { Router, type IRouter } from "express";
import healthRouter from "./health";
import lectureLensRouter from "./lectureLens";
import studyRoomsRouter from "./studyRooms";
import ragRouter from "./rag";

const router: IRouter = Router();

router.use(healthRouter);
router.use(lectureLensRouter);
router.use("/rag", ragRouter);
router.use(studyRoomsRouter);

export default router;
