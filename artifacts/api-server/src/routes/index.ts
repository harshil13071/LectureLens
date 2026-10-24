import { Router, type IRouter } from "express";
import healthRouter from "./health";
import lectureLensRouter from "./lectureLens";

const router: IRouter = Router();

router.use(healthRouter);
router.use(lectureLensRouter);

export default router;
