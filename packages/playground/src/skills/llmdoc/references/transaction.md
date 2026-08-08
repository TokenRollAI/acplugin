# Transaction

完整 llmdoc v3 应先构造并校验全部候选知识，再以可恢复事务提交，任何失败都保留上一次完整状态。

本模板没有知识 writer、stage、backup、swap 或 rollback。不要把 ACPlugin 自身的产物事务误认为 llmdoc 知识事务已经实现。
