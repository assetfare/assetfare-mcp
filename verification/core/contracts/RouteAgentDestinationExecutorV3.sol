// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IERC20DestinationV3Minimal {function balanceOf(address) external view returns(uint256);function transfer(address,uint256) external returns(bool);function transferFrom(address,address,uint256) external returns(bool);function approve(address,uint256) external returns(bool);}
interface IWETHDestinationV3Minimal is IERC20DestinationV3Minimal {function withdraw(uint256) external;}
interface ISwapRouter02DestinationV3Minimal {
    struct ExactInputSingleParams {address tokenIn;address tokenOut;uint24 fee;address recipient;uint256 amountIn;uint256 amountOutMinimum;uint160 sqrtPriceLimitX96;}
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns(uint256 amountOut);
}

/// @notice Session-isolated destination settlement with exact 1bp AssetFare fee.
/// @dev No business amount maximum and no service-fee maximum. maximumInputUSDC
/// remains caller/session specific so unrelated smart-account funds never expand
/// one session's authorization.
contract RouteAgentDestinationExecutorV3 {
    IERC20DestinationV3Minimal public immutable USDC;IWETHDestinationV3Minimal public immutable WETH;ISwapRouter02DestinationV3Minimal public immutable ROUTER;address public immutable FEE_RECIPIENT;
    uint256 public constant ROUTE_FEE_BPS=1;uint256 private locked=1;
    event Settled(address indexed account,address indexed recipient,uint256 inputUSDC,uint256 feeUSDC,uint256 outputETH);
    constructor(address usdc,address weth,address router,address feeRecipient){require(usdc!=address(0)&&weth!=address(0)&&router!=address(0)&&feeRecipient!=address(0),"zero address");USDC=IERC20DestinationV3Minimal(usdc);WETH=IWETHDestinationV3Minimal(weth);ROUTER=ISwapRouter02DestinationV3Minimal(router);FEE_RECIPIENT=feeRecipient;}
    modifier nonReentrant(){require(locked==1,"reentrant");locked=2;_;locked=1;}
    function settleUpTo(address recipient,uint24 poolFee,uint256 maximumInputUSDC,uint256 amountOutMinimum,uint256 deadline) external nonReentrant returns(uint256 amountOut){
        require(recipient!=address(0)&&block.timestamp<=deadline,"invalid settlement");require(poolFee==100||poolFee==500||poolFee==3000||poolFee==10000,"fee not allowed");require(maximumInputUSDC>30_000,"maximum too small");
        uint256 balance=USDC.balanceOf(msg.sender);uint256 inputUSDC=balance<maximumInputUSDC?balance:maximumInputUSDC;require(inputUSDC>30_000,"balance too small");uint256 routeFee=inputUSDC/10_000;uint256 swapAmount=inputUSDC-routeFee;require(routeFee>0,"fee precision");uint256 beforeBalance=USDC.balanceOf(address(this));
        require(USDC.transferFrom(msg.sender,address(this),inputUSDC),"transferFrom failed");require(USDC.transfer(FEE_RECIPIENT,routeFee),"fee transfer failed");require(USDC.approve(address(ROUTER),swapAmount),"approve failed");
        amountOut=ROUTER.exactInputSingle(ISwapRouter02DestinationV3Minimal.ExactInputSingleParams({tokenIn:address(USDC),tokenOut:address(WETH),fee:poolFee,recipient:address(this),amountIn:swapAmount,amountOutMinimum:amountOutMinimum,sqrtPriceLimitX96:0}));
        require(USDC.approve(address(ROUTER),0),"approval reset failed");require(USDC.balanceOf(address(this))==beforeBalance,"retained USDC");WETH.withdraw(amountOut);(bool sent,)=recipient.call{value:amountOut}("");require(sent,"ETH transfer failed");emit Settled(msg.sender,recipient,inputUSDC,routeFee,amountOut);
    }
    receive() external payable {require(msg.sender==address(WETH),"ETH rejected");}
}
